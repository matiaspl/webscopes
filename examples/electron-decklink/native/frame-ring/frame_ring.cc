#include <node_api.h>

#include <algorithm>
#include <cerrno>
#include <cstdint>
#include <cstring>
#include <limits>
#include <stdexcept>
#include <string>
#include <vector>

#ifdef _WIN32
#include <windows.h>
#else
#include <fcntl.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <unistd.h>
#endif

namespace {

constexpr uint32_t kMagic = 0x57534752; // WSGR
constexpr uint32_t kVersion = 2;
constexpr uint32_t kFree = 0;
constexpr uint32_t kWriting = 1;
constexpr uint32_t kReady = 2;
constexpr uint32_t kReading = 3;
constexpr size_t kHeaderBytes = 64;
constexpr size_t kSlotHeaderBytes = 64;

struct SharedHeader {
  uint32_t magic;
  uint32_t version;
  uint32_t slotCount;
  uint32_t slotSize;
  uint64_t mappingSize;
  uint64_t nextSequence;
  uint64_t dropped;
  uint8_t reserved[kHeaderBytes - 40];
};

struct SlotHeader {
  uint32_t state;
  uint32_t reserved0;
  uint64_t sequence;
  uint32_t width;
  uint32_t height;
  uint32_t rowBytes;
  uint32_t byteLength;
  int64_t timestamp;
  uint32_t colorMatrixCode;
  int32_t eotf;
  uint8_t reserved[kSlotHeaderBytes - 48];
};

static_assert(sizeof(SharedHeader) == kHeaderBytes, "ring header must stay fixed-size");
static_assert(sizeof(SlotHeader) == kSlotHeaderBytes, "slot header must stay fixed-size");

uint32_t load32(uint32_t* value) {
#ifdef _WIN32
  return static_cast<uint32_t>(InterlockedCompareExchange(reinterpret_cast<volatile LONG*>(value), 0, 0));
#else
  return __atomic_load_n(value, __ATOMIC_ACQUIRE);
#endif
}

void store32(uint32_t* value, uint32_t next) {
#ifdef _WIN32
  InterlockedExchange(reinterpret_cast<volatile LONG*>(value), static_cast<LONG>(next));
#else
  __atomic_store_n(value, next, __ATOMIC_RELEASE);
#endif
}

bool compareExchange32(uint32_t* value, uint32_t expected, uint32_t next) {
#ifdef _WIN32
  return static_cast<uint32_t>(InterlockedCompareExchange(reinterpret_cast<volatile LONG*>(value),
    static_cast<LONG>(next), static_cast<LONG>(expected))) == expected;
#else
  return __atomic_compare_exchange_n(value, &expected, next, false, __ATOMIC_ACQ_REL, __ATOMIC_ACQUIRE);
#endif
}

uint64_t fetchAdd64(uint64_t* value, uint64_t amount) {
#ifdef _WIN32
  return static_cast<uint64_t>(InterlockedExchangeAdd64(reinterpret_cast<volatile LONG64*>(value), static_cast<LONG64>(amount)));
#else
  return __atomic_fetch_add(value, amount, __ATOMIC_RELAXED);
#endif
}

bool readString(napi_env env, napi_value value, std::string* output) {
  size_t length = 0;
  if (napi_get_value_string_utf8(env, value, nullptr, 0, &length) != napi_ok) return false;
  std::vector<char> buffer(length + 1);
  if (napi_get_value_string_utf8(env, value, buffer.data(), buffer.size(), &length) != napi_ok) return false;
  output->assign(buffer.data(), length);
  return true;
}

bool readUint32(napi_env env, napi_value value, uint32_t* output) {
  return napi_get_value_uint32(env, value, output) == napi_ok;
}

bool readPropertyUint32(napi_env env, napi_value object, const char* name, uint32_t* output) {
  napi_value value;
  return napi_get_named_property(env, object, name, &value) == napi_ok && readUint32(env, value, output);
}

bool readPropertyInt64(napi_env env, napi_value object, const char* name, int64_t* output) {
  napi_value value;
  int64_t result = 0;
  if (napi_get_named_property(env, object, name, &value) != napi_ok
    || napi_get_value_int64(env, value, &result) != napi_ok) return false;
  *output = result;
  return true;
}

void setUint32(napi_env env, napi_value object, const char* name, uint32_t value) {
  napi_value property;
  napi_create_uint32(env, value, &property);
  napi_set_named_property(env, object, name, property);
}

void setUint64(napi_env env, napi_value object, const char* name, uint64_t value) {
  napi_value property;
  napi_create_bigint_uint64(env, value, &property);
  napi_set_named_property(env, object, name, property);
}

class FrameRing {
 public:
  FrameRing(const std::string& requestedName, uint32_t slotCount, uint32_t slotSize, bool create)
    : name_(requestedName), slotCount_(slotCount), slotSize_(slotSize), owner_(create) {
    if (name_.empty() || slotCount_ < 2 || slotCount_ > 16 || slotSize_ < 16) throw std::runtime_error("Invalid frame ring dimensions");
    if (slotSize_ > std::numeric_limits<uint32_t>::max()) throw std::runtime_error("Frame ring slot is too large");
    mappingSize_ = kHeaderBytes + static_cast<size_t>(slotCount_) * (kSlotHeaderBytes + slotSize_);
    if (mappingSize_ < kHeaderBytes || mappingSize_ > std::numeric_limits<size_t>::max()) throw std::runtime_error("Frame ring size overflow");
#ifdef _WIN32
    const std::string mappingName = name_;
    if (create) {
      mapping_ = CreateFileMappingA(INVALID_HANDLE_VALUE, nullptr, PAGE_READWRITE,
        static_cast<DWORD>(mappingSize_ >> 32), static_cast<DWORD>(mappingSize_ & 0xffffffffu), mappingName.c_str());
      if (!mapping_) throw std::runtime_error("CreateFileMapping failed");
      owner_ = GetLastError() != ERROR_ALREADY_EXISTS;
    } else {
      mapping_ = OpenFileMappingA(FILE_MAP_ALL_ACCESS, FALSE, mappingName.c_str());
      if (!mapping_) throw std::runtime_error("OpenFileMapping failed");
    }
    mappingView_ = MapViewOfFile(mapping_, FILE_MAP_ALL_ACCESS, 0, 0, mappingSize_);
    if (!mappingView_) throw std::runtime_error("MapViewOfFile failed");
#else
    shmName_ = "/" + name_;
    for (char& character : shmName_) if (character == '/') character = '_';
    shmName_[0] = '/';
    const int flags = create ? (O_CREAT | O_RDWR) : O_RDWR;
    fd_ = shm_open(shmName_.c_str(), flags, 0600);
    if (fd_ < 0) throw std::runtime_error(std::string("shm_open failed: ") + std::strerror(errno));
    if (create && ftruncate(fd_, static_cast<off_t>(mappingSize_)) != 0) throw std::runtime_error(std::string("ftruncate failed: ") + std::strerror(errno));
    mappingView_ = mmap(nullptr, mappingSize_, PROT_READ | PROT_WRITE, MAP_SHARED, fd_, 0);
    if (mappingView_ == MAP_FAILED) { mappingView_ = nullptr; throw std::runtime_error("mmap failed"); }
#endif
    header_ = reinterpret_cast<SharedHeader*>(mappingView_);
    bool initialize = create && (header_->magic != kMagic || header_->version != kVersion || header_->mappingSize != mappingSize_);
    if (initialize) {
      std::memset(mappingView_, 0, mappingSize_);
      header_->magic = kMagic;
      header_->version = kVersion;
      header_->slotCount = slotCount_;
      header_->slotSize = slotSize_;
      header_->mappingSize = mappingSize_;
    } else if (header_->magic != kMagic || header_->version != kVersion || header_->slotCount != slotCount_ || header_->slotSize != slotSize_) {
      close();
      throw std::runtime_error("Frame ring metadata does not match");
    }
  }

  ~FrameRing() { close(); }

  void close() {
    if (!mappingView_) return;
#ifdef _WIN32
    UnmapViewOfFile(mappingView_);
    mappingView_ = nullptr;
    if (mapping_) CloseHandle(mapping_);
    mapping_ = nullptr;
#else
    munmap(mappingView_, mappingSize_);
    mappingView_ = nullptr;
    if (fd_ >= 0) ::close(fd_);
    fd_ = -1;
    if (owner_ && !shmName_.empty()) shm_unlink(shmName_.c_str());
#endif
    header_ = nullptr;
  }

  bool write(const uint8_t* data, size_t length, uint32_t width, uint32_t height, uint32_t rowBytes, int64_t timestamp,
    uint32_t colorMatrixCode, int64_t eotf,
    uint64_t* sequence, uint64_t* dropped) {
    if (!header_) throw std::runtime_error("Frame ring is closed");
    if (length > slotSize_) throw std::runtime_error("Frame exceeds the configured ring slot");
    int selected = -1;
    bool overwroteReady = false;
    for (uint32_t index = 0; index < slotCount_; ++index) {
      SlotHeader* slot = slotAt(index);
      if (compareExchange32(&slot->state, kFree, kWriting)) { selected = static_cast<int>(index); break; }
    }
    if (selected < 0) {
      uint64_t oldest = std::numeric_limits<uint64_t>::max();
      for (uint32_t index = 0; index < slotCount_; ++index) {
        SlotHeader* slot = slotAt(index);
        if (load32(&slot->state) == kReady && slot->sequence < oldest) { oldest = slot->sequence; selected = static_cast<int>(index); }
      }
      if (selected >= 0 && compareExchange32(&slotAt(static_cast<uint32_t>(selected))->state, kReady, kWriting)) {
        overwroteReady = true;
      } else {
        selected = -1;
      }
    }
    if (selected < 0) {
      *dropped = fetchAdd64(&header_->dropped, 1) + 1;
      return false;
    }
    SlotHeader* slot = slotAt(static_cast<uint32_t>(selected));
    if (overwroteReady) fetchAdd64(&header_->dropped, 1);
    std::memcpy(payloadAt(slot), data, length);
    slot->width = width;
    slot->height = height;
    slot->rowBytes = rowBytes;
    slot->byteLength = static_cast<uint32_t>(length);
    slot->timestamp = timestamp;
    slot->colorMatrixCode = colorMatrixCode;
    slot->eotf = static_cast<int32_t>(eotf);
    slot->sequence = fetchAdd64(&header_->nextSequence, 1) + 1;
    store32(&slot->state, kReady);
    *sequence = slot->sequence;
    *dropped = load64(&header_->dropped);
    return true;
  }

  napi_value readLatest(napi_env env, napi_value reusable) {
    if (!header_) {
      napi_value nullValue;
      napi_get_null(env, &nullValue);
      return nullValue;
    }
    int selected = -1;
    uint64_t newest = 0;
    for (uint32_t index = 0; index < slotCount_; ++index) {
      SlotHeader* slot = slotAt(index);
      if (load32(&slot->state) == kReady && slot->sequence >= newest) { newest = slot->sequence; selected = static_cast<int>(index); }
    }
    if (selected < 0 || !compareExchange32(&slotAt(static_cast<uint32_t>(selected))->state, kReady, kReading)) {
      napi_value nullValue;
      napi_get_null(env, &nullValue);
      return nullValue;
    }
    SlotHeader* slot = slotAt(static_cast<uint32_t>(selected));
    napi_value data;
    void* output = nullptr;
    bool reused = false;
    bool isArrayBuffer = false;
    if (reusable && napi_is_arraybuffer(env, reusable, &isArrayBuffer) == napi_ok && isArrayBuffer) {
      size_t reusableLength = 0;
      void* reusableData = nullptr;
      if (napi_get_arraybuffer_info(env, reusable, &reusableData, &reusableLength) == napi_ok
        && reusableData && reusableLength >= slot->byteLength) {
        data = reusable;
        output = reusableData;
        reused = true;
      }
    }
    if (!reused && reusable) {
      bool isTypedArray = false;
      if (napi_is_typedarray(env, reusable, &isTypedArray) == napi_ok && isTypedArray) {
        napi_typedarray_type type;
        size_t elementCount = 0;
        void* reusableData = nullptr;
        napi_value backingBuffer;
        size_t byteOffset = 0;
        if (napi_get_typedarray_info(env, reusable, &type, &elementCount, &reusableData, &backingBuffer, &byteOffset) == napi_ok
          && type == napi_uint8_array && reusableData && elementCount >= slot->byteLength) {
          data = reusable;
          output = reusableData;
          reused = true;
        }
      }
    }
    if (!reused && napi_create_arraybuffer(env, slot->byteLength, &output, &data) != napi_ok) {
      store32(&slot->state, kFree);
      napi_value nullValue;
      napi_get_null(env, &nullValue);
      return nullValue;
    }
    std::memcpy(output, payloadAt(slot), slot->byteLength);
    napi_value result;
    napi_create_object(env, &result);
    napi_set_named_property(env, result, "data", data);
    setUint32(env, result, "width", slot->width);
    setUint32(env, result, "height", slot->height);
    setUint32(env, result, "bytesPerRow", slot->rowBytes);
    setUint32(env, result, "byteLength", slot->byteLength);
    setUint64(env, result, "sequence", slot->sequence);
    napi_value timestamp;
    napi_create_int64(env, slot->timestamp, &timestamp);
    napi_set_named_property(env, result, "timestamp", timestamp);
    setUint32(env, result, "colorMatrixCode", slot->colorMatrixCode);
    napi_value eotf;
    napi_create_int32(env, slot->eotf, &eotf);
    napi_set_named_property(env, result, "eotf", eotf);
    store32(&slot->state, kFree);
    for (uint32_t index = 0; index < slotCount_; ++index) {
      if (static_cast<int>(index) == selected) continue;
      SlotHeader* older = slotAt(index);
      if (load32(&older->state) == kReady && older->sequence < newest && compareExchange32(&older->state, kReady, kFree)) {
        fetchAdd64(&header_->dropped, 1);
      }
    }
    return result;
  }

  uint64_t load64(uint64_t* value) const {
#ifdef _WIN32
    return static_cast<uint64_t>(InterlockedCompareExchange64(reinterpret_cast<volatile LONG64*>(value), 0, 0));
#else
    return __atomic_load_n(value, __ATOMIC_ACQUIRE);
#endif
  }

  SlotHeader* slotAt(uint32_t index) const {
    auto* base = reinterpret_cast<uint8_t*>(mappingView_) + kHeaderBytes;
    return reinterpret_cast<SlotHeader*>(base + index * (kSlotHeaderBytes + slotSize_));
  }

  uint8_t* payloadAt(SlotHeader* slot) const { return reinterpret_cast<uint8_t*>(slot) + kSlotHeaderBytes; }

  uint64_t dropped() const { return header_ ? load64(&header_->dropped) : 0; }

  uint32_t readyCount() const {
    if (!header_) return 0;
    uint32_t count = 0;
    for (uint32_t index = 0; index < slotCount_; ++index) if (load32(&slotAt(index)->state) == kReady) ++count;
    return count;
  }

 private:
  std::string name_;
  uint32_t slotCount_;
  uint32_t slotSize_;
  size_t mappingSize_;
  bool owner_;
  void* mappingView_ = nullptr;
  SharedHeader* header_ = nullptr;
#ifdef _WIN32
  HANDLE mapping_ = nullptr;
#else
  int fd_ = -1;
  std::string shmName_;
#endif
};

FrameRing* unwrap(napi_env env, napi_callback_info info, napi_value* thisArg, size_t* argc, napi_value* argv) {
  napi_get_cb_info(env, info, argc, argv, thisArg, nullptr);
  FrameRing* ring = nullptr;
  napi_unwrap(env, *thisArg, reinterpret_cast<void**>(&ring));
  return ring;
}

void finalizeRing(napi_env, void* data, void*) { delete static_cast<FrameRing*>(data); }

napi_value ringConstructor(napi_env env, napi_callback_info info) {
  size_t argc = 4;
  napi_value argv[4];
  napi_value thisArg;
  napi_get_cb_info(env, info, &argc, argv, &thisArg, nullptr);
  if (argc < 3) { napi_throw_type_error(env, nullptr, "FrameRing(name, slotCount, slotSize, create) requires dimensions"); return nullptr; }
  std::string name;
  uint32_t slotCount = 0;
  uint32_t slotSize = 0;
  bool create = false;
  if (!readString(env, argv[0], &name) || !readUint32(env, argv[1], &slotCount) || !readUint32(env, argv[2], &slotSize)
    || (argc >= 4 && napi_get_value_bool(env, argv[3], &create) != napi_ok)) {
    napi_throw_type_error(env, nullptr, "Invalid FrameRing constructor arguments");
    return nullptr;
  }
  try {
    napi_wrap(env, thisArg, new FrameRing(name, slotCount, slotSize, create), finalizeRing, nullptr, nullptr);
  } catch (const std::exception& error) {
    napi_throw_error(env, nullptr, error.what());
    return nullptr;
  }
  return thisArg;
}

napi_value ringWrite(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  napi_value thisArg;
  FrameRing* ring = unwrap(env, info, &thisArg, &argc, argv);
  if (!ring || argc < 2) { napi_throw_type_error(env, nullptr, "writeFrame(data, metadata) requires two arguments"); return nullptr; }
  void* data = nullptr;
  size_t length = 0;
  bool isBuffer = false;
  napi_is_buffer(env, argv[0], &isBuffer);
  if (isBuffer) {
    if (napi_get_buffer_info(env, argv[0], &data, &length) != napi_ok) data = nullptr;
  } else {
    napi_typedarray_type type;
    napi_value arrayBuffer;
    size_t byteOffset = 0;
    size_t elementLength = 0;
    bool isTyped = false;
    napi_is_typedarray(env, argv[0], &isTyped);
    if (!isTyped || napi_get_typedarray_info(env, argv[0], &type, &elementLength, &data, &arrayBuffer, &byteOffset) != napi_ok
      || (type != napi_uint8_array && type != napi_uint8_clamped_array)) data = nullptr;
    length = elementLength;
  }
  uint32_t width = 0, height = 0, rowBytes = 0;
  int64_t timestamp = 0;
  uint32_t colorMatrixCode = 0;
  int64_t eotf = -1;
  if (!data || !readPropertyUint32(env, argv[1], "width", &width) || !readPropertyUint32(env, argv[1], "height", &height)
    || !readPropertyUint32(env, argv[1], "bytesPerRow", &rowBytes)) {
    napi_throw_type_error(env, nullptr, "writeFrame expects Uint8Array data and width/height/bytesPerRow metadata");
    return nullptr;
  }
  readPropertyInt64(env, argv[1], "timestamp", &timestamp);
  readPropertyUint32(env, argv[1], "colorMatrixCode", &colorMatrixCode);
  readPropertyInt64(env, argv[1], "eotf", &eotf);
  uint64_t sequence = 0, dropped = 0;
  bool published = false;
  try { published = ring->write(static_cast<const uint8_t*>(data), length, width, height, rowBytes, timestamp, colorMatrixCode, eotf, &sequence, &dropped); }
  catch (const std::exception& error) { napi_throw_range_error(env, nullptr, error.what()); return nullptr; }
  napi_value result;
  napi_create_object(env, &result);
  napi_value publishedValue;
  napi_get_boolean(env, published, &publishedValue);
  napi_set_named_property(env, result, "published", publishedValue);
  setUint64(env, result, "sequence", sequence);
  setUint64(env, result, "dropped", dropped);
  return result;
}

napi_value ringReadLatest(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_value thisArg;
  FrameRing* ring = unwrap(env, info, &thisArg, &argc, argv);
  if (!ring) { napi_throw_error(env, nullptr, "FrameRing is closed"); return nullptr; }
  return ring->readLatest(env, argc > 0 ? argv[0] : nullptr);
}

napi_value ringStats(napi_env env, napi_callback_info info) {
  size_t argc = 0;
  napi_value thisArg;
  FrameRing* ring = unwrap(env, info, &thisArg, &argc, nullptr);
  if (!ring) { napi_throw_error(env, nullptr, "FrameRing is closed"); return nullptr; }
  napi_value result;
  napi_create_object(env, &result);
  setUint64(env, result, "dropped", ring->dropped());
  setUint32(env, result, "ready", ring->readyCount());
  return result;
}

napi_value ringClose(napi_env env, napi_callback_info info) {
  size_t argc = 0;
  napi_value thisArg;
  FrameRing* ring = unwrap(env, info, &thisArg, &argc, nullptr);
  if (ring) ring->close();
  napi_value undefined;
  napi_get_undefined(env, &undefined);
  return undefined;
}

napi_value init(napi_env env, napi_value exports) {
  napi_property_descriptor properties[] = {
    { "writeFrame", nullptr, ringWrite, nullptr, nullptr, nullptr, napi_default, nullptr },
    { "readLatest", nullptr, ringReadLatest, nullptr, nullptr, nullptr, napi_default, nullptr },
    { "stats", nullptr, ringStats, nullptr, nullptr, nullptr, napi_default, nullptr },
    { "close", nullptr, ringClose, nullptr, nullptr, nullptr, napi_default, nullptr },
  };
  napi_value constructor;
  napi_define_class(env, "FrameRing", NAPI_AUTO_LENGTH, ringConstructor, nullptr,
    sizeof(properties) / sizeof(properties[0]), properties, &constructor);
  napi_set_named_property(env, exports, "FrameRing", constructor);
  return exports;
}

} // namespace

NAPI_MODULE_INIT() { return init(env, exports); }

#include <node_api.h>
#include <CoreFoundation/CoreFoundation.h>
#include <CoreVideo/CoreVideo.h>
#include <IOSurface/IOSurface.h>
#include <climits>
#include <cstdint>
#include <cstring>
#include <limits>

namespace {

struct Surface {
  IOSurfaceRef value = nullptr;
};

void setNumber(CFMutableDictionaryRef dictionary, CFStringRef key, int32_t number) {
  CFNumberRef value = CFNumberCreate(kCFAllocatorDefault, kCFNumberSInt32Type, &number);
  CFDictionarySetValue(dictionary, key, value);
  CFRelease(value);
}

void finalize(napi_env, void* data, void*) {
  auto* surface = static_cast<Surface*>(data);
  if (surface->value) CFRelease(surface->value);
  delete surface;
}

Surface* getSurface(napi_env env, napi_callback_info info) {
  napi_value self;
  size_t argc = 0;
  napi_get_cb_info(env, info, &argc, nullptr, &self, nullptr);
  Surface* surface = nullptr;
  napi_unwrap(env, self, reinterpret_cast<void**>(&surface));
  return surface;
}

napi_value closeSurface(napi_env env, napi_callback_info info) {
  Surface* surface = getSurface(env, info);
  if (surface && surface->value) {
    CFRelease(surface->value);
    surface->value = nullptr;
  }
  napi_value undefined;
  napi_get_undefined(env, &undefined);
  return undefined;
}

napi_value copyPixels(napi_env env, napi_callback_info info) {
  Surface* surface = getSurface(env, info);
  if (!surface || !surface->value) { napi_throw_error(env, nullptr, "IOSurface is closed"); return nullptr; }
  IOSurfaceLock(surface->value, kIOSurfaceLockReadOnly, nullptr);
  const size_t size = IOSurfaceGetBytesPerRow(surface->value) * IOSurfaceGetHeight(surface->value);
  napi_value output;
  napi_create_buffer_copy(env, size, IOSurfaceGetBaseAddress(surface->value), nullptr, &output);
  IOSurfaceUnlock(surface->value, kIOSurfaceLockReadOnly, nullptr);
  return output;
}

napi_value createPackedSurface(napi_env env, napi_callback_info info) {
  size_t argc = 4;
  napi_value args[4];
  napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
  if (argc != 4) { napi_throw_type_error(env, nullptr, "createPackedSurface(data, width, height, v210BytesPerRow) expects four arguments"); return nullptr; }
  bool isTyped = false;
  napi_is_typedarray(env, args[0], &isTyped);
  napi_typedarray_type type;
  size_t length = 0;
  void* input = nullptr;
  napi_value backing;
  size_t offset = 0;
  uint32_t pictureWidth = 0, height = 0, sourceStride = 0;
  if (!isTyped || napi_get_typedarray_info(env, args[0], &type, &length, &input, &backing, &offset) != napi_ok
    || type != napi_uint8_array || napi_get_value_uint32(env, args[1], &pictureWidth) != napi_ok
    || napi_get_value_uint32(env, args[2], &height) != napi_ok
    || napi_get_value_uint32(env, args[3], &sourceStride) != napi_ok
    || pictureWidth == 0 || height == 0 || sourceStride < ((pictureWidth + 5u) / 6u) * 16u
    || sourceStride % 4u != 0 || static_cast<uint64_t>(sourceStride) * height > length) {
    napi_throw_range_error(env, nullptr, "Invalid v210 frame layout");
    return nullptr;
  }
  const uint32_t rgbaWidth = (sourceStride + 2u) / 3u;
  if (rgbaWidth > INT32_MAX || height > INT32_MAX) {
    napi_throw_range_error(env, nullptr, "RGBA surface dimensions exceed IOSurface limits");
    return nullptr;
  }
  CFMutableDictionaryRef properties = CFDictionaryCreateMutable(kCFAllocatorDefault, 0,
    &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
  const size_t alignedStride = IOSurfaceAlignProperty(kIOSurfaceBytesPerRow, static_cast<size_t>(rgbaWidth) * 4u);
  const size_t allocationSize = IOSurfaceAlignProperty(kIOSurfaceAllocSize, alignedStride * height);
  if (!alignedStride || !allocationSize || alignedStride > INT32_MAX || allocationSize > INT32_MAX) {
    CFRelease(properties);
    napi_throw_range_error(env, nullptr, "RGBA surface allocation exceeds IOSurface limits");
    return nullptr;
  }
  setNumber(properties, kIOSurfaceWidth, static_cast<int32_t>(rgbaWidth));
  setNumber(properties, kIOSurfaceHeight, static_cast<int32_t>(height));
  setNumber(properties, kIOSurfaceBytesPerElement, 4);
  setNumber(properties, kIOSurfaceElementHeight, 1);
  setNumber(properties, kIOSurfaceBytesPerRow, static_cast<int32_t>(alignedStride));
  setNumber(properties, kIOSurfaceAllocSize, static_cast<int32_t>(allocationSize));
  setNumber(properties, kIOSurfacePixelFormat, static_cast<int32_t>(kCVPixelFormatType_32RGBA));
  IOSurfaceRef ioSurface = IOSurfaceCreate(properties);
  CFRelease(properties);
  if (!ioSurface) { napi_throw_error(env, nullptr, "IOSurfaceCreate failed"); return nullptr; }
  if (IOSurfaceLock(ioSurface, 0, nullptr) != kIOReturnSuccess) {
    CFRelease(ioSurface);
    napi_throw_error(env, nullptr, "IOSurfaceLock failed");
    return nullptr;
  }
  auto* source = static_cast<const uint8_t*>(input);
  auto* destination = static_cast<uint8_t*>(IOSurfaceGetBaseAddress(ioSurface));
  const size_t destinationStride = IOSurfaceGetBytesPerRow(ioSurface);
  for (uint32_t y = 0; y < height; ++y) {
    const auto* srcRow = source + static_cast<size_t>(y) * sourceStride;
    auto* dstRow = destination + static_cast<size_t>(y) * destinationStride;
    std::memset(dstRow, 0, destinationStride);
    for (uint32_t byte = 0; byte < sourceStride; ++byte) {
      dstRow[(byte / 3u) * 4u + byte % 3u] = srcRow[byte];
    }
    for (uint32_t x = 0; x < rgbaWidth; ++x) dstRow[x * 4u + 3u] = 255;
  }
  IOSurfaceUnlock(ioSurface, 0, nullptr);

  auto* surface = new Surface{ioSurface};
  napi_value result;
  napi_create_object(env, &result);
  napi_wrap(env, result, surface, finalize, nullptr, nullptr);
  napi_value handle;
  IOSurfaceRef pointer = ioSurface;
  napi_create_buffer_copy(env, sizeof(pointer), &pointer, nullptr, &handle);
  napi_set_named_property(env, result, "ioSurface", handle);
  napi_value number;
  napi_create_uint32(env, rgbaWidth, &number);
  napi_set_named_property(env, result, "width", number);
  napi_create_uint32(env, height, &number);
  napi_set_named_property(env, result, "height", number);
  napi_create_uint32(env, static_cast<uint32_t>(destinationStride), &number);
  napi_set_named_property(env, result, "bytesPerRow", number);
  napi_property_descriptor methods[] = {
    {"close", nullptr, closeSurface, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"copyPixels", nullptr, copyPixels, nullptr, nullptr, nullptr, napi_default, nullptr},
  };
  napi_define_properties(env, result, 2, methods);
  return result;
}

} // namespace

NAPI_MODULE_INIT() {
  napi_property_descriptor method = {"createPackedSurface", nullptr, createPackedSurface, nullptr, nullptr, nullptr, napi_default, nullptr};
  napi_define_properties(env, exports, 1, &method);
  return exports;
}

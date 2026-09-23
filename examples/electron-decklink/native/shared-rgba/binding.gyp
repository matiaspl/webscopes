{
  "targets": [{
    "target_name": "shared_rgba",
    "sources": ["shared_rgba.cc"],
    "cflags_cc": ["-std=c++17", "-fexceptions"],
    "xcode_settings": {
      "CLANG_CXX_LANGUAGE_STANDARD": "c++17",
      "GCC_ENABLE_CPP_EXCEPTIONS": "YES",
      "OTHER_LDFLAGS": ["-framework", "IOSurface", "-framework", "CoreFoundation", "-framework", "CoreVideo"]
    }
  }]
}

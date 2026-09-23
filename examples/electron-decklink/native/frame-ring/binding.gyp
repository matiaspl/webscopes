{
  "targets": [
    {
      "target_name": "frame_ring",
      "sources": ["frame_ring.cc"],
      "cflags_cc": ["-std=c++17", "-fexceptions"],
      "xcode_settings": { "CLANG_CXX_LANGUAGE_STANDARD": "c++17", "GCC_ENABLE_CPP_EXCEPTIONS": "YES" },
      "msvs_settings": { "VCCLCompilerTool": { "AdditionalOptions": ["/std:c++17", "/EHsc"] } }
    }
  ]
}

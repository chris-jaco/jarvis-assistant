// Optional standalone audit adapter. Never linked into Atlas/Electron.
#include <sherpa-onnx/c-api/c-api.h>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#ifdef _WIN32
#include <windows.h>
#include <string>
#include <vector>
#endif
static int RunReference(int argc, char **argv) {
#ifdef _WIN32
  std::freopen("NUL", "w", stderr);
#else
  std::freopen("/dev/null", "w", stderr);
#endif
  if (argc != 8) return 2;
  char *end = nullptr;
  float threshold = std::strtof(argv[7], &end);
  if (!end || *end || !std::isfinite(threshold) || threshold <= 0 || threshold > 1) return 2;
  const auto *wave = SherpaOnnxReadWave(argv[6]);
  if (!wave || wave->sample_rate != 16000 || wave->num_samples <= 0 || wave->num_samples > 4800000) {
    if (wave) SherpaOnnxFreeWave(wave); return 2;
  }
  SherpaOnnxKeywordSpotterConfig config{};
  config.feat_config.sample_rate = 16000; config.feat_config.feature_dim = 80;
  config.model_config.transducer.encoder = argv[1]; config.model_config.transducer.decoder = argv[2];
  config.model_config.transducer.joiner = argv[3]; config.model_config.tokens = argv[4];
  config.model_config.num_threads = 1; config.model_config.provider = "cpu";
  config.max_active_paths = 4; config.num_trailing_blanks = 1;
  config.keywords_score = 1; config.keywords_threshold = threshold;
  config.keywords_buf = argv[5]; config.keywords_buf_size = std::strlen(argv[5]);
  const auto *spotter = SherpaOnnxCreateKeywordSpotter(&config);
  if (!spotter) { SherpaOnnxFreeWave(wave); return 2; }
  const auto *stream = SherpaOnnxCreateKeywordStream(spotter);
  if (!stream) { SherpaOnnxDestroyKeywordSpotter(spotter); SherpaOnnxFreeWave(wave); return 2; }
  int hits = 0, blocks = 0;
  for (int at = 0; at < wave->num_samples; at += 1600) {
    int n = wave->num_samples - at; if (n > 1600) n = 1600;
    SherpaOnnxOnlineStreamAcceptWaveform(stream, 16000, wave->samples + at, n);
    while (SherpaOnnxIsKeywordStreamReady(spotter, stream)) {
      SherpaOnnxDecodeKeywordStream(spotter, stream);
      const auto *result = SherpaOnnxGetKeywordResult(spotter, stream);
      if (!result) { SherpaOnnxDestroyOnlineStream(stream); SherpaOnnxDestroyKeywordSpotter(spotter); SherpaOnnxFreeWave(wave); return 2; }
      if (result->keyword && result->keyword[0]) { hits++; SherpaOnnxResetKeywordStream(spotter, stream); }
      SherpaOnnxDestroyKeywordResult(result);
    }
    blocks++;
  }
  // Deliberately no tail padding and no InputFinished: match the WASM streaming path.
  std::printf("{\"rawHits\":%d,\"processedSamples\":%d,\"blocks\":%d,\"appendedSilenceSamples\":0}", hits, wave->num_samples, blocks);
  SherpaOnnxDestroyOnlineStream(stream); SherpaOnnxDestroyKeywordSpotter(spotter); SherpaOnnxFreeWave(wave);
  return 0;
}

#ifdef _WIN32
// Preserve U+2581 keyword pieces and Unicode paths through Windows argv.
int wmain(int argc, wchar_t **wide) {
  std::vector<std::string> text; text.reserve(argc);
  for (int i = 0; i < argc; ++i) {
    int n = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, wide[i], -1, nullptr, 0, nullptr, nullptr);
    if (n <= 0) return 2;
    std::string value(n, '\0');
    if (!WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, wide[i], -1, value.data(), n, nullptr, nullptr)) return 2;
    value.pop_back(); text.push_back(std::move(value));
  }
  std::vector<char *> args; args.reserve(argc);
  for (auto &value : text) args.push_back(value.data());
  return RunReference(argc, args.data());
}
#else
int main(int argc, char **argv) { return RunReference(argc, argv); }
#endif

// Isolated benchmark adapter. Never linked into Atlas/Electron.
#include <sherpa-onnx/c-api/c-api.h>
#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <iomanip>
#include <iostream>
#include <limits>
#include <locale>
#include <memory>
#include <sstream>
#include <string>
#include <utility>
#include <vector>
#ifdef _WIN32
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#include <bcrypt.h>
#include <psapi.h>
#endif
struct Failure { const char *code; };
static double Wall() {
#ifdef _WIN32
  LARGE_INTEGER n{}, f{};
  if (!QueryPerformanceCounter(&n) || !QueryPerformanceFrequency(&f) || f.QuadPart <= 0) throw Failure{"WALL_CLOCK_FAILED"};
  return 1000.0 * static_cast<double>(n.QuadPart) / f.QuadPart;
#else
  return std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now().time_since_epoch()).count();
#endif
}
static double Cpu() {
#ifdef _WIN32
  FILETIME c{}, e{}, k{}, u{};
  if (!GetThreadTimes(GetCurrentThread(), &c, &e, &k, &u)) return -1;
  auto ticks = [](FILETIME x) { return (static_cast<uint64_t>(x.dwHighDateTime) << 32) | x.dwLowDateTime; };
  return static_cast<double>(ticks(k) + ticks(u)) / 10000.0;
#else
  return -1;
#endif
}
static double Delta(double start) { const double end = Cpu(); return start < 0 || end < start ? -1 : end - start; }
static void Number(std::ostream &o, double v) { if (v < 0 || !std::isfinite(v)) o << "null"; else o << v; }
struct Memory { uint64_t rss = 0, peak = 0; bool available = false; };
static Memory Mem() {
#ifdef _WIN32
  PROCESS_MEMORY_COUNTERS_EX m{}; m.cb = sizeof(m);
  if (GetProcessMemoryInfo(GetCurrentProcess(), reinterpret_cast<PROCESS_MEMORY_COUNTERS *>(&m), sizeof(m))) return {m.WorkingSetSize, m.PeakWorkingSetSize, true};
#endif
  return {};
}
static std::vector<unsigned char> Read(const std::filesystem::path &path) {
  std::ifstream f(path, std::ios::binary | std::ios::ate);
  if (!f || f.tellg() <= 0 || f.tellg() > 100000000) throw Failure{"INPUT_FILE_INVALID"};
  const auto size = static_cast<size_t>(f.tellg()); std::vector<unsigned char> bytes(size);
  f.seekg(0); if (!f.read(reinterpret_cast<char *>(bytes.data()), size)) throw Failure{"INPUT_FILE_INVALID"}; return bytes;
}
static std::string Hash(const unsigned char *data, size_t n) {
#ifdef _WIN32
  if (n > std::numeric_limits<ULONG>::max()) throw Failure{"HASH_FAILED"};
  unsigned char digest[32]{};
  if (BCryptHash(BCRYPT_SHA256_ALG_HANDLE, nullptr, 0, const_cast<PUCHAR>(data), static_cast<ULONG>(n), digest, sizeof(digest)) < 0) throw Failure{"HASH_FAILED"};
  std::ostringstream o; o << std::hex << std::setfill('0'); for (auto b : digest) o << std::setw(2) << static_cast<unsigned>(b); return o.str();
#else
  (void)data; (void)n; throw Failure{"WINDOWS_REQUIRED"};
#endif
}
static std::string FileHash(const std::filesystem::path &p) { const auto bytes = Read(p); return Hash(bytes.data(), bytes.size()); }
static uint32_t U32(const std::vector<unsigned char> &b, size_t p) { if (p + 4 > b.size()) throw Failure{"WAV_INVALID"}; return b[p] | uint32_t(b[p+1])<<8 | uint32_t(b[p+2])<<16 | uint32_t(b[p+3])<<24; }
static uint16_t U16(const std::vector<unsigned char> &b, size_t p) { if (p + 2 > b.size()) throw Failure{"WAV_INVALID"}; return b[p] | uint16_t(b[p+1])<<8; }
static void ValidateWave(const std::vector<unsigned char> &b) {
  if (b.size() < 44 || std::memcmp(b.data(), "RIFF", 4) || std::memcmp(b.data()+8,"WAVE",4) || U32(b,4) != b.size()-8) throw Failure{"WAV_INVALID"};
  bool fmt=false, data=false;
  for (size_t p=12; p<b.size();) {
    if (p+8>b.size()) throw Failure{"WAV_INVALID"}; const auto n=U32(b,p+4); const size_t end=p+8+static_cast<size_t>(n);
    if (end>b.size()) throw Failure{"WAV_INVALID"};
    if (!std::memcmp(b.data()+p,"fmt ",4)) {
      if (fmt || n<16 || U16(b,p+8)!=1 || U16(b,p+10)!=1 || U32(b,p+12)!=16000 || U32(b,p+16)!=32000 || U16(b,p+20)!=2 || U16(b,p+22)!=16) throw Failure{"WAV_FORMAT_REQUIRED"}; fmt=true;
    }
    if (!std::memcmp(b.data()+p,"data",4)) { if (data || n!=330411u*2) throw Failure{"WAV_SAMPLE_COUNT_MISMATCH"}; data=true; }
    p=end+(n&1); if (p>b.size()) throw Failure{"WAV_INVALID"};
  }
  if (!fmt || !data) throw Failure{"WAV_INVALID"};
}
struct Dll { std::string name, hash; };
static std::vector<Dll> LoadedDlls() {
  std::vector<Dll> dlls;
#ifdef _WIN32
  wchar_t exe[32768]{}; const DWORD n=GetModuleFileNameW(nullptr,exe,32768);
  if (!n || n>=32768) throw Failure{"DLL_LOCATION_FAILED"}; const auto directory=std::filesystem::path(exe).parent_path();
  for (const auto *name : {L"sherpa-onnx-c-api.dll", L"onnxruntime.dll"}) {
    const auto h=GetModuleHandleW(name); wchar_t path[32768]{}; const DWORD len=h?GetModuleFileNameW(h,path,32768):0;
    if (!len || len>=32768 || !std::filesystem::equivalent(directory,std::filesystem::path(path).parent_path())) throw Failure{"DLL_LOCATION_MISMATCH"};
    dlls.push_back({name==std::wstring(L"onnxruntime.dll")?"onnxruntime.dll":"sherpa-onnx-c-api.dll",FileHash(std::filesystem::path(path))});
  }
#endif
  return dlls;
}
struct Decode { int block; double wall, cpu; };
struct Block { int sequence, calls, hits; double wall, cpu; };
struct Position { int block; double start; std::vector<float> timestamps; };
struct Hit { int block, start, end, raw; };
struct Run {
  int calls=0, raw=0, detected=0, suppressed=0, samples=0; double totalWall=0, totalCpu=-1, maxBlock=0, lastHit=-1e30;
  std::vector<Position> positions; std::vector<Decode> decodes; std::vector<Block> blocks; std::vector<Hit> events;
};
using ResultPtr=std::unique_ptr<const SherpaOnnxKeywordResult,decltype(&SherpaOnnxDestroyKeywordResult)>;
static void Feed(const SherpaOnnxKeywordSpotter *spotter,const SherpaOnnxOnlineStream *stream,const float *pcm,int n,int at,Run &r) {
  const double start=Wall(), cpu=Cpu(); const int block=at/1600; int hits=0, calls=0;
  SherpaOnnxOnlineStreamAcceptWaveform(stream,16000,pcm,n);
  while (SherpaOnnxIsKeywordStreamReady(spotter,stream)) {
    if (++r.calls>10000) throw Failure{"DECODE_LIMIT"}; calls++;
    const double d=Wall(), c=Cpu(); SherpaOnnxDecodeKeywordStream(spotter,stream);
    const double elapsed=Wall()-d, used=Delta(c); r.decodes.push_back({block,elapsed,used});
    ResultPtr result(SherpaOnnxGetKeywordResult(spotter,stream),SherpaOnnxDestroyKeywordResult);
    if (!result) throw Failure{"RESULT_FAILED"};
    if (result->keyword && result->keyword[0]) {
      if (std::strcmp(result->keyword,"sherpaw_0")) throw Failure{"KEYWORD_ID_MISMATCH"};
      if (result->count<1 || result->count>32 || !result->timestamps || !std::isfinite(result->start_time) || result->start_time<0) throw Failure{"POSITION_INVALID"};
      Position position{block,result->start_time,{}};
      for(int i=0;i<result->count;i++){float t=result->timestamps[i];if(!std::isfinite(t)||t<0)throw Failure{"POSITION_INVALID"};position.timestamps.push_back(t);}r.positions.push_back(std::move(position));
      if (++r.raw>1000) throw Failure{"HIT_LIMIT"}; hits++;
      if (at/16.0-r.lastHit>=1000) { r.detected++; r.lastHit=at/16.0; } else r.suppressed++;
      SherpaOnnxResetKeywordStream(spotter,stream);
    }
  }
  if (hits) r.events.push_back({block,at,at+n,hits});
  r.samples+=n; const double duration=Wall()-start, used=Delta(cpu); r.maxBlock=std::max(r.maxBlock,duration);
  r.blocks.push_back({block,calls,hits,duration,used});
}
static void ReplaceStream(const SherpaOnnxKeywordSpotter *s, const SherpaOnnxOnlineStream *&stream) {
  auto next=SherpaOnnxCreateKeywordStream(s); if (!next) throw Failure{"RESET_FAILED"};
  if (next==stream) throw Failure{"RESET_FAILED"}; SherpaOnnxDestroyOnlineStream(stream); stream=next;
}
static int RunReference(int argc,char **argv) {
  if (argc!=8 && argc!=9) throw Failure{"ARGUMENT_INVALID"}; const bool warm=argc==9;
  if (warm && std::strcmp(argv[8],"--warm")) throw Failure{"ARGUMENT_INVALID"};
  char *end=nullptr; const float threshold=std::strtof(argv[7],&end);
  if (!end || *end || !std::isfinite(threshold) || threshold!=.25f) throw Failure{"THRESHOLD_REQUIRED"};
  const auto dlls=LoadedDlls(); const std::string version=SherpaOnnxGetVersionStr(), git=SherpaOnnxGetGitSha1();
  if (version!="2.0.0" || git.size()<8 || git.substr(0,8)!="8abb7c8f" || git.find_first_not_of("0123456789abcdef")!=std::string::npos) throw Failure{"RUNTIME_VERSION_MISMATCH"};
  std::vector<std::string> modelHashes; for(int i=1;i<=4;i++) modelHashes.push_back(FileHash(std::filesystem::u8path(argv[i])));
  auto bytes=Read(std::filesystem::u8path(argv[6])); ValidateWave(bytes); const auto wavHash=Hash(bytes.data(),bytes.size());
  using WavePtr=std::unique_ptr<const SherpaOnnxWave,decltype(&SherpaOnnxFreeWave)>;
  WavePtr wave(SherpaOnnxReadWave(argv[6]),SherpaOnnxFreeWave);
  if (!wave || wave->sample_rate!=16000 || wave->num_samples!=330411) throw Failure{"WAV_INVALID"};
  std::vector<unsigned char> canonical(wave->num_samples*4);
  for(int i=0;i<wave->num_samples;i++) { if(!std::isfinite(wave->samples[i])) throw Failure{"PCM_INVALID"}; uint32_t word; std::memcpy(&word,wave->samples+i,4); for(int j=0;j<4;j++) canonical[i*4+j]=static_cast<unsigned char>(word>>(j*8)); }
  const auto pcmHash=Hash(canonical.data(),canonical.size()); std::fill(canonical.begin(),canonical.end(),0); std::fill(bytes.begin(),bytes.end(),0);
  const std::string keywords=argv[5], keywordHash=Hash(reinterpret_cast<const unsigned char *>(keywords.data()),keywords.size());
  SherpaOnnxKeywordSpotterConfig config{};
  config.feat_config.sample_rate = 16000; config.feat_config.feature_dim = 80;
  config.model_config.transducer.encoder=argv[1]; config.model_config.transducer.decoder=argv[2]; config.model_config.transducer.joiner=argv[3]; config.model_config.tokens=argv[4];
  config.model_config.num_threads=1; config.model_config.provider="cpu";
  config.max_active_paths=4; config.num_trailing_blanks = 1; config.keywords_score=1; config.keywords_threshold=threshold;
  config.keywords_buf=argv[5]; if (keywords.size()>INT32_MAX) throw Failure{"ARGUMENT_INVALID"}; config.keywords_buf_size=static_cast<int32_t>(keywords.size());
  const double init=Wall();
  using SpotterPtr=std::unique_ptr<const SherpaOnnxKeywordSpotter,decltype(&SherpaOnnxDestroyKeywordSpotter)>;
  SpotterPtr spotter(SherpaOnnxCreateKeywordSpotter(&config),SherpaOnnxDestroyKeywordSpotter); if (!spotter) throw Failure{"MODEL_LOAD_FAILED"};
  const SherpaOnnxOnlineStream *stream=SherpaOnnxCreateKeywordStream(spotter.get()); if (!stream) throw Failure{"STREAM_FAILED"};
  struct Guard { const SherpaOnnxOnlineStream *&p; ~Guard(){if(p)SherpaOnnxDestroyOnlineStream(p);} } guard{stream};
  const double initWall=Wall()-init, prepStart=Wall(); int warmBlocks=0; Run preparation;
  if (warm) {
    float zero[1600]{};
    while (preparation.calls<2 && warmBlocks<30) {
      if (Wall()-prepStart>=10000) throw Failure{"WARMUP_TIMEOUT"}; Feed(spotter.get(),stream,zero,1600,warmBlocks*1600,preparation); warmBlocks++;
    }
    if (preparation.calls<2) throw Failure{"WARMUP_LIMIT"}; if (Wall()-prepStart>=10000) throw Failure{"WARMUP_TIMEOUT"};
  }
  const double resetStart=Wall(); ReplaceStream(spotter.get(),stream); const double resetWall=Wall()-resetStart, preparationWall=Wall()-prepStart;
  Run r; const auto before=Mem(); const double processStart=Wall(), cpuStart=Cpu();
  for(int at=0;at<wave->num_samples;at+=1600) Feed(spotter.get(),stream,wave->samples+at,std::min(1600,wave->num_samples-at),at,r);
  r.totalWall=Wall()-processStart; r.totalCpu=Delta(cpuStart); const auto after=Mem();
  for(int i=0;i<wave->num_samples;i++) { uint32_t word;std::memcpy(&word,wave->samples+i,4);for(int j=0;j<4;j++)canonical[i*4+j]=static_cast<unsigned char>(word>>(j*8)); }
  if(Hash(canonical.data(),canonical.size())!=pcmHash)throw Failure{"PCM_MUTATED"};std::fill(canonical.begin(),canonical.end(),0);
  // No tail padding and no InputFinished. Cleanup completes before emitting a successful report.
  SherpaOnnxDestroyOnlineStream(stream); stream=nullptr; spotter.reset(); wave.reset();
  std::cout.imbue(std::locale::classic()); std::cout<<std::setprecision(17);
  auto &o=std::cout; o<<"{\"schema\":1,\"state\":\"COMPLETED\",\"backend\":\"NATIVE\",\"mode\":\""<<(warm?"WARM":"COLD")<<"\",\"runtime\":{\"version\":\"2.0.0\",\"git\":\""<<git<<"\",\"dlls\":[";
  for(size_t i=0;i<dlls.size();i++){if(i)o<<',';o<<"{\"name\":\""<<dlls[i].name<<"\",\"sha256\":\""<<dlls[i].hash<<"\"}";} o<<"]},";
  o<<"\"configuration\":{\"threshold\":0.25,\"score\":1,\"maxActivePaths\":4,\"cooldownMs\":1000,\"sampleRate\":16000,\"channels\":1,\"blockSamples\":1600,\"numTrailingBlanks\":1,\"featureDim\":80},\"modelHashes\":{";
  const char *names[]={"encoder.onnx","decoder.onnx","joiner.onnx","tokens.txt"}; for(int i=0;i<4;i++){if(i)o<<',';o<<'"'<<names[i]<<"\":\""<<modelHashes[i]<<'"';}
  o<<"},\"keywordSha256\":\""<<keywordHash<<"\",\"wavSha256\":\""<<wavHash<<"\",\"pcmSha256\":\""<<pcmHash<<"\",\"processedSamples\":"<<r.samples<<",\"blocks\":"<<r.blocks.size()<<",\"rawHits\":"<<r.raw<<",\"detections\":"<<r.detected<<",\"suppressedHits\":"<<r.suppressed<<",\"appendedSilenceSamples\":0,\"events\":[";
  for(size_t i=0;i<r.events.size();i++){auto h=r.events[i];if(i)o<<',';o<<"{\"block\":"<<h.block<<",\"sampleOffset\":"<<h.start<<",\"sampleEnd\":"<<h.end<<",\"rawHits\":"<<h.raw<<'}';}
  o<<"],\"hitPositions\":[";
  for(size_t i=0;i<r.positions.size();i++){const auto &p=r.positions[i];if(i)o<<',';o<<"{\"block\":"<<p.block<<",\"startTimeSec\":"<<p.start<<",\"timestampsSec\":[";for(size_t j=0;j<p.timestamps.size();j++){if(j)o<<',';o<<p.timestamps[j];}o<<"]}";}
  o<<"],\"initializationWallMs\":"<<initWall<<",\"preparation\":{\"syntheticBlocks\":"<<warmBlocks<<",\"decodeCalls\":"<<preparation.calls<<",\"wallMs\":"<<preparationWall<<",\"resetWallMs\":"<<resetWall<<",\"newStream\":true},\"processing\":{\"wallMs\":"<<r.totalWall<<",\"threadCpuMs\":";Number(o,r.totalCpu);o<<",\"rtf\":"<<r.totalWall/(r.samples/16.0)<<",\"maxBlockWallMs\":"<<r.maxBlock<<"},\"decodes\":[";
  for(size_t i=0;i<r.decodes.size();i++){auto d=r.decodes[i];if(i)o<<',';o<<"{\"block\":"<<d.block<<",\"wallMs\":"<<d.wall<<",\"threadCpuMs\":";Number(o,d.cpu);o<<'}';}
  o<<"],\"blockMetrics\":[";
  for(size_t i=0;i<r.blocks.size();i++){auto b=r.blocks[i];if(i)o<<',';o<<"{\"sequence\":"<<b.sequence<<",\"wallMs\":"<<b.wall<<",\"threadCpuMs\":";Number(o,b.cpu);o<<",\"decodeCalls\":"<<b.calls<<",\"rawHits\":"<<b.hits<<'}';}
  o<<"],\"memory\":{\"residentStartBytes\":";if(before.available)o<<before.rss;else o<<"null";o<<",\"residentEndBytes\":";if(after.available)o<<after.rss;else o<<"null";o<<",\"residentPeakBytes\":";if(after.available)o<<after.peak;else o<<"null";o<<",\"peakKind\":\"OS_PEAK\",\"wasmHeapBytes\":null},\"cleanupCompleted\":true}"<<std::endl;
  return 0;
}
#ifndef ATLAS_REFERENCE_LIBRARY
static int SafeMain(int argc,char **argv) {
#ifdef _WIN32
  std::freopen("NUL","w",stderr);
#else
  std::freopen("/dev/null","w",stderr);
#endif
  try {return RunReference(argc,argv);} catch(const Failure &e){std::cout<<"{\"state\":\"FAILED\",\"code\":\""<<e.code<<"\"}"<<std::endl;return 2;} catch(...){std::cout<<"{\"state\":\"FAILED\",\"code\":\"NATIVE_REFERENCE_FAILED\"}"<<std::endl;return 2;}
}
#ifdef _WIN32
int wmain(int argc,wchar_t **wide) {
  try {
    std::vector<std::string> text; text.reserve(argc);
    for(int i=0;i<argc;i++){int n=WideCharToMultiByte(CP_UTF8,WC_ERR_INVALID_CHARS,wide[i],-1,nullptr,0,nullptr,nullptr);if(n<=0)throw Failure{"ARGUMENT_INVALID"};std::string s(n,'\0');if(!WideCharToMultiByte(CP_UTF8,WC_ERR_INVALID_CHARS,wide[i],-1,s.data(),n,nullptr,nullptr))throw Failure{"ARGUMENT_INVALID"};s.pop_back();text.push_back(std::move(s));}
    std::vector<char *> args;for(auto &s:text)args.push_back(s.data());return SafeMain(argc,args.data());
  }catch(...){std::cout<<"{\"state\":\"FAILED\",\"code\":\"ARGUMENT_INVALID\"}"<<std::endl;return 2;}
}
#else
int main(int argc,char **argv){return SafeMain(argc,argv);}
#endif

#endif  // ATLAS_REFERENCE_LIBRARY

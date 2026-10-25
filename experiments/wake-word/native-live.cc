// Independent experimental Windows executable. Never linked into Atlas.
#define ATLAS_REFERENCE_LIBRARY
#include "reference-kws.cc"
#include "native-live-core.h"
#include "native-fn-core.h"
#include "native-calibration-core.h"
#include <thread>
#include <cwctype>
// Parse only the four authorized nominal values, before any engine/capture is created.
static double ParseLiveThreshold(const char *value) {
  if (!std::strcmp(value,"0.25")) return .25;
  if (!std::strcmp(value,"0.15")) return .15;
  if (!std::strcmp(value,"0.10") || !std::strcmp(value,"0.1")) return .10;
  if (!std::strcmp(value,"0.05")) return .05;
  throw Failure{"ARGUMENT_INVALID"};
}
static std::string LiveKeyword(double threshold) {
  const char *text=threshold==.25?"0.25":threshold==.15?"0.15":threshold==.10?"0.1":"0.05";
  return std::string("▁a t la s :1 #")+text+" @sherpaw_0";
}
#ifdef _WIN32
#include <audioclient.h>
#include <mmdeviceapi.h>
#include <mmreg.h>
#include <wrl/client.h>
using Microsoft::WRL::ComPtr;
namespace live = atlas_live;

struct Handle {
  HANDLE h = nullptr;
  explicit Handle(bool manual = false) : h(CreateEventW(nullptr, manual, FALSE, nullptr)) { if (!h) throw Failure{"EVENT_FAILED"}; }
  ~Handle() { if (h) CloseHandle(h); }
  Handle(const Handle &) = delete;
};
struct Shared {
  Handle stop{true}, ready{true}, data, captureDone{true}, inferenceDone{true};
  live::Queue queue;
  live::Block tail;
  std::atomic<const char *> error{nullptr};
  std::atomic<bool> cancelled{false};
  std::atomic<uint64_t> highWater{0};
  bool captureReleased = true, comReleased = true, engineReleased = true;
  std::atomic<bool> started{false}, captureFinished{false};
  bool fnEnabled=false, fnChannelHealthy=true;
  std::string trialId, markerInput;
  double fnOrigin=0;
  atlas_fn::Receiver receiver;
  std::vector<atlas_fn::Marker> markers;
  std::vector<atlas_fn::Block> diagnosticBlocks;
  std::vector<atlas_fn::Decode> diagnosticDecodes;
  double thresholdFloat32 = -1;
  bool replay = false;
  bool calReplay=false,calSave=false,calPersisted=false;
  size_t calSamples=0;std::string calPath,calHash;atlas_cal::Buffer recording;
  std::string wavHash, pcmHash, processedPcmHash;
  live::Format format{};
  live::Continuity continuity;
  std::array<live::Signal, 8> signal{};
  live::Signal outputSignal;
  uint64_t frames = 0, convertedFrames = 0, emitted = 0, enqueued = 0, silentFrames = 0, overflows = 0;
  uint64_t abandonedBlocks = 0;
  uint32_t endpointFrames = 0, firTaps = 0;
  double filterDelayMs = 0, captureWallMs = 0, initWallMs = 0, preparationWallMs = 0, resetWallMs = 0;
  double micReleaseWallMs = -1, engineReleaseWallMs = -1;
  double processWallMs = 0, inferenceCpuMs = -1, maxQueueAgeMs = 0, maxBlockEndLatencyMs = 0, cleanupWallMs = 0;
  bool newStream = false;
  int warmBlocks = 0, warmDecodes = 0, sequenceErrors = 0;
  Run run;
  Memory memoryStart, memoryEnd, memoryAfterCleanup;
  std::array<uint64_t, 12> residentWindows{};
  std::vector<double> blockEndLatencies;
  void fail(const char *code) { const char *empty = nullptr; error.compare_exchange_strong(empty, code); SetEvent(stop.h); SetEvent(data.h); }
};
static std::atomic<Shared *> controlState{nullptr};
static std::atomic<unsigned> controlCalls{0};
static BOOL WINAPI Control(DWORD type) {
  controlCalls.fetch_add(1);
  const auto state = controlState.load();
  const bool handled = state && (type == CTRL_C_EVENT || type == CTRL_BREAK_EVENT);
  if (handled) { state->cancelled.store(true); SetEvent(state->stop.h); }
  controlCalls.fetch_sub(1);
  return handled ? TRUE : FALSE;
}
static bool stopped(Shared &s) { return WaitForSingleObject(s.stop.h, 0) == WAIT_OBJECT_0; }
static void Check(HRESULT result, const char *stage) { if (FAILED(result)) throw Failure{stage}; }

struct Progress {
  HANDLE handle = nullptr, wake=nullptr;
  bool muted=false, asynchronous=false;
  atlas_fn::LogQueue messages;
  std::atomic<bool> failed{false}, finishing{false};
  std::thread writer;
  Progress() {
    const HANDLE original=GetStdHandle(STD_ERROR_HANDLE);
    if(original&&original!=INVALID_HANDLE_VALUE)DuplicateHandle(GetCurrentProcess(),original,GetCurrentProcess(),&handle,0,FALSE,DUPLICATE_SAME_ACCESS);
    muted=std::freopen("NUL","w",stderr)!=nullptr;
  }
  void startAsync(){
    wake=CreateEventW(nullptr,FALSE,FALSE,nullptr);if(!wake)throw Failure{"EVENT_FAILED"};
    asynchronous=true;
    writer=std::thread([this]{
      std::array<char,128> text{};
      for(;;){
        while(messages.pop(text)){if(failed.load())return;DWORD written=0;const auto n=static_cast<DWORD>(std::strlen(text.data()));
          if(!WriteFile(handle,text.data(),n,&written,nullptr)||written!=n){failed.store(true);return;}}
        if(finishing.load())return;
        if(WaitForSingleObject(wake,100)==WAIT_FAILED){failed.store(true);return;}
      }
    });
  }
  void write(const char *stage){
    if(asynchronous){if(!messages.push(stage))failed.store(true);SetEvent(wake);return;}
    if(handle){DWORD written=0;WriteFile(handle,stage,static_cast<DWORD>(std::strlen(stage)),&written,nullptr);}
  }
  bool finish(){
    if(writer.joinable()){
      finishing.store(true);SetEvent(wake);
      // Main/control only, after audio threads joined. Never wait in capture.
      if(WaitForSingleObject(writer.native_handle(),500)!=WAIT_OBJECT_0){failed.store(true);CancelSynchronousIo(writer.native_handle());SetEvent(wake);}
      writer.join();if(!messages.drained())failed.store(true);
    }
    return !failed.load();
  }
  ~Progress(){finish();if(wake)CloseHandle(wake);if(handle)CloseHandle(handle);}
};
struct ComScope {
  ComScope() { Check(CoInitializeEx(nullptr, COINIT_MULTITHREADED), "COM_INITIALIZATION_FAILED"); }
  ~ComScope() { CoUninitialize(); }
};
struct WasapiCaptureSession {
  Shared &state;
  ComPtr<IMMDeviceEnumerator> enumerator;
  ComPtr<IMMDevice> device;
  ComPtr<IAudioClient> client;
  ComPtr<IAudioCaptureClient> capture;
  WAVEFORMATEX *mix = nullptr;
  Handle event;
  bool running = false;
  double startWall = 0;
  explicit WasapiCaptureSession(Shared &s) : state(s) { state.captureReleased = false; }
  ~WasapiCaptureSession() {
    double cleanupStart=0;try{cleanupStart=Wall();}catch(...){state.fail("CAPTURE_CLOCK_FAILED");}
    if(running){try{state.captureWallMs=Wall()-startWall;}catch(...){state.fail("CAPTURE_CLOCK_FAILED");}
      if(FAILED(client->Stop()))state.fail("CAPTURE_STOP_FAILED");}
    capture.Reset(); client.Reset(); device.Reset(); enumerator.Reset();
    if (mix) CoTaskMemFree(mix);
    state.captureReleased = true;
    if(cleanupStart)try{state.micReleaseWallMs=Wall()-cleanupStart;}catch(...){state.fail("CAPTURE_CLOCK_FAILED");}
  }
};
static live::Format CaptureFormat(const WAVEFORMATEX *wave) {
  if (!wave) throw Failure{"CAPTURE_FORMAT_UNSUPPORTED"};
  WORD tag = wave->wFormatTag, valid = wave->wBitsPerSample;
  if (tag == WAVE_FORMAT_EXTENSIBLE) {
    if (wave->cbSize < sizeof(WAVEFORMATEXTENSIBLE) - sizeof(WAVEFORMATEX)) throw Failure{"CAPTURE_FORMAT_UNSUPPORTED"};
    const auto *ext = reinterpret_cast<const WAVEFORMATEXTENSIBLE *>(wave);
    valid = ext->Samples.wValidBitsPerSample;
    const GUID ieee{WAVE_FORMAT_IEEE_FLOAT,0,0x0010,{0x80,0,0,0xaa,0,0x38,0x9b,0x71}};
    const GUID pcm{WAVE_FORMAT_PCM,0,0x0010,{0x80,0,0,0xaa,0,0x38,0x9b,0x71}};
    if (IsEqualGUID(ext->SubFormat, ieee)) tag = WAVE_FORMAT_IEEE_FLOAT;
    else if (IsEqualGUID(ext->SubFormat, pcm)) tag = WAVE_FORMAT_PCM;
    else throw Failure{"CAPTURE_FORMAT_UNSUPPORTED"};
  }
  live::Kind kind;
  if (tag == WAVE_FORMAT_IEEE_FLOAT && wave->wBitsPerSample == 32) kind = live::Kind::float32;
  else if (tag == WAVE_FORMAT_IEEE_FLOAT && wave->wBitsPerSample == 64) kind = live::Kind::float64;
  else if (tag == WAVE_FORMAT_PCM && wave->wBitsPerSample == 16) kind = live::Kind::pcm16;
  else if (tag == WAVE_FORMAT_PCM && wave->wBitsPerSample == 24) kind = live::Kind::pcm24;
  else if (tag == WAVE_FORMAT_PCM && wave->wBitsPerSample == 32) kind = live::Kind::pcm32;
  else throw Failure{"CAPTURE_FORMAT_UNSUPPORTED"};
  live::Format f{wave->nSamplesPerSec, wave->nChannels, uint32_t(wave->wBitsPerSample / 8), valid, kind};
  live::validate(f);
  if (wave->nBlockAlign != f.bytes * f.channels || wave->nAvgBytesPerSec != f.rate * wave->nBlockAlign) throw Failure{"CAPTURE_FORMAT_UNSUPPORTED"};
  return f;
}
static void Capture(Shared &s, int seconds, Progress &progress) noexcept {
  try {
    {
      ComScope com; s.comReleased = false;
      {
        WasapiCaptureSession mic(s);
        Check(CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL, IID_PPV_ARGS(mic.enumerator.GetAddressOf())), "DEVICE_ENUMERATION_FAILED");
        Check(mic.enumerator->GetDefaultAudioEndpoint(eCapture, eConsole, mic.device.GetAddressOf()), "MICROPHONE_UNAVAILABLE");
        Check(mic.device->Activate(__uuidof(IAudioClient), CLSCTX_ALL, nullptr, reinterpret_cast<void **>(mic.client.GetAddressOf())), "CAPTURE_ACTIVATION_FAILED");
        Check(mic.client->GetMixFormat(&mic.mix), "CAPTURE_FORMAT_FAILED");
        s.format = CaptureFormat(mic.mix);
        live::Resampler resampler(s.format.rate); live::Assembler assembler;
        s.firTaps = resampler.taps(); s.filterDelayMs = resampler.delayMs();
        // Exact mix format, no AUTOCONVERTPCM or SRC flags; all conversion is explicit above.
        Check(mic.client->Initialize(AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_EVENTCALLBACK, 0, 0, mic.mix, nullptr), "CAPTURE_INITIALIZATION_FAILED");
        Check(mic.client->GetBufferSize(&s.endpointFrames), "CAPTURE_BUFFER_FAILED");
        if (!s.endpointFrames || s.endpointFrames > s.format.rate) throw Failure{"CAPTURE_BUFFER_UNSUPPORTED"};
        Check(mic.client->SetEventHandle(mic.event.h), "CAPTURE_EVENT_FAILED");
        Check(mic.client->GetService(IID_PPV_ARGS(mic.capture.GetAddressOf())), "CAPTURE_SERVICE_FAILED");
        if (!stopped(s)) {
          Check(mic.client->Start(), "CAPTURE_START_FAILED"); mic.running = true; s.started = true;
          const double start = Wall(); mic.startWall = start; progress.write("CAPTURE_STARTED\n");
          HANDLE events[]{s.stop.h, mic.event.h};
          while (!stopped(s) && Wall() - start < seconds * 1000.0) {
            const DWORD wait = WaitForMultipleObjects(2, events, FALSE, 50);
            if (wait == WAIT_FAILED) throw Failure{"CAPTURE_WAIT_FAILED"};
            if (stopped(s) || Wall() - start >= seconds * 1000.0) break;
            if (wait != WAIT_OBJECT_0 + 1) continue;
            UINT32 packetFrames = 0; Check(mic.capture->GetNextPacketSize(&packetFrames), "CAPTURE_PACKET_FAILED");
            while (packetFrames && !stopped(s) && Wall() - start < seconds * 1000.0) {
              BYTE *bytes = nullptr; UINT32 frames = 0; DWORD flags = 0; UINT64 position = 0, qpc = 0;
              Check(mic.capture->GetBuffer(&bytes, &frames, &flags, &position, &qpc), "CAPTURE_READ_FAILED");
              struct Packet { IAudioCaptureClient *p; UINT32 n; Shared &s; bool owned=true;
                HRESULT release() {owned=false;return p->ReleaseBuffer(n);}
                ~Packet() {if(owned && FAILED(release()))s.fail("CAPTURE_RELEASE_FAILED");} } packet{mic.capture.Get(), frames, s};
              if (!frames || frames > s.endpointFrames) throw Failure{"CAPTURE_PACKET_INVALID"};
              if(flags & ~(AUDCLNT_BUFFERFLAGS_SILENT|AUDCLNT_BUFFERFLAGS_DATA_DISCONTINUITY|AUDCLNT_BUFFERFLAGS_TIMESTAMP_ERROR))throw Failure{"CAPTURE_PACKET_INVALID"};
              s.frames += frames;
              s.continuity.packet(position, frames, (flags & AUDCLNT_BUFFERFLAGS_DATA_DISCONTINUITY) != 0, (flags & AUDCLNT_BUFFERFLAGS_TIMESTAMP_ERROR) != 0);
              if (!qpc || double(qpc) / 10000 > Wall() + 10) throw Failure{"CAPTURE_TIMESTAMP_INVALID"};
              const bool silent = (flags & AUDCLNT_BUFFERFLAGS_SILENT) != 0;
              if (!silent && !bytes) throw Failure{"CAPTURE_PACKET_INVALID"};
              if (silent) s.silentFrames += frames;
              for (UINT32 frame = 0; frame < frames; frame++) {
                float first = 0;
                for (uint32_t channel = 0; channel < s.format.channels; channel++) {
                  const auto value = silent ? 0 : live::sample(bytes + (size_t(frame) * s.format.channels + channel) * s.format.bytes, s.format.kind);
                  s.signal[channel].add(value); if (!channel) first = value;
                }
                s.convertedFrames++;
                const double sampleWallMs = double(qpc) / 10000 + (frame + 1) * 1000.0 / s.format.rate;
                resampler.accept(first, [&](float value) {
                  s.emitted++;s.outputSignal.add(value);
                  assembler.accept(value, sampleWallMs - s.filterDelayMs, [&](const live::Block &block) {
                    uint64_t pending = 0;
                    if (!s.queue.push(block, &pending)) { s.overflows++; return false; }
                    s.enqueued++; s.highWater.store(std::max(s.highWater.load(), pending)); SetEvent(s.data.h); return true;
                  });
                });
              }
              Check(packet.release(), "CAPTURE_RELEASE_FAILED");
              Check(mic.capture->GetNextPacketSize(&packetFrames), "CAPTURE_PACKET_FAILED");
            }
          }
          s.captureWallMs = Wall() - start;
        }
        s.tail = assembler.tail();  // Only real residual samples; no FIR flush/padding.
      } // Stop + release audio COM interfaces even while the decoder is still running.
    }
    s.comReleased = true;
  } catch (const Failure &e) { s.fail(e.code); }
    catch (const live::Error &e) { s.fail(e.code); }
    catch (...) { s.fail("CAPTURE_FAILED"); }
  // CoUninitialize's scope already ended on both normal and exception paths.
  s.comReleased = true;
  s.captureFinished.store(true,std::memory_order_release);
  SetEvent(s.captureDone.h); SetEvent(s.data.h); progress.write("CAPTURE_STOPPED\n");
}

// Authorized PCM16 WAV replay through Native Live's assembler/queue/decoder.
// Nominal audio pacing, no microphone, conversions, padding or InputFinished.
static void Replay(Shared &s, const char *path, Progress &progress) noexcept {
  try {
    auto bytes=Read(std::filesystem::u8path(path));ValidateWave(bytes);s.wavHash=Hash(bytes.data(),bytes.size());std::fill(bytes.begin(),bytes.end(),0);
    using Wave=std::unique_ptr<const SherpaOnnxWave,decltype(&SherpaOnnxFreeWave)>;
    Wave wave(SherpaOnnxReadWave(path),SherpaOnnxFreeWave);
    if(!wave||wave->sample_rate!=16000||wave->num_samples!=330411)throw Failure{"WAV_INVALID"};
    std::vector<unsigned char> canonical(330411*4);
    std::memcpy(canonical.data(),wave->samples,canonical.size());
    s.pcmHash=Hash(canonical.data(),canonical.size());std::fill(canonical.begin(),canonical.end(),0);
    if(s.pcmHash!="ddd500ae3b79de9fa1f9af82c04142dfd1b06dd2fca5237008f0cd3af3b5138b")throw Failure{"PCM_HASH_MISMATCH"};
    s.format={16000,1,2,16,live::Kind::pcm16};s.firTaps=1;
    live::Resampler resampler(16000);live::Assembler assembler;
    const double start=Wall();s.started.store(true);progress.write("REPLAY_STARTED\n");
    for(int at=0;at<wave->num_samples && !stopped(s);at+=1600){
      const int n=std::min(1600,wave->num_samples-at);
      const double deadline=start+(at+n)/16.0;
      while(!stopped(s)&&Wall()<deadline)WaitForSingleObject(s.stop.h,1);
      if(stopped(s))break;
      s.frames+=n;
      for(int i=0;i<n;i++){
        const float sample=wave->samples[at+i];s.signal[0].add(sample);s.convertedFrames++;
        resampler.accept(sample,[&](float value){s.emitted++;s.outputSignal.add(value);
          assembler.accept(value,start+(at+i+1)/16.0,[&](const live::Block &block){uint64_t pending=0;
            if(!s.queue.push(block,&pending)){s.overflows++;return false;}
            s.enqueued++;s.highWater.store(std::max(s.highWater.load(),pending));SetEvent(s.data.h);return true;});});
      }
    }
    s.tail=assembler.tail();s.captureWallMs=Wall()-start;
    std::memcpy(canonical.data(),wave->samples,canonical.size());const auto after=Hash(canonical.data(),canonical.size());std::fill(canonical.begin(),canonical.end(),0);
    if(after!=s.pcmHash)throw Failure{"PCM_MUTATED"};
  }catch(const Failure &e){s.fail(e.code);}catch(const live::Error &e){s.fail(e.code);}catch(...){s.fail("REPLAY_FAILED");}
  s.captureFinished.store(true,std::memory_order_release);SetEvent(s.captureDone.h);SetEvent(s.data.h);progress.write("REPLAY_STOPPED\n");
}

// All disk access is outside the WASAPI thread. Reject reparse ancestors and overwrite.
static std::filesystem::path CalPath(const std::string &text) {
  auto path=std::filesystem::u8path(text);if(!path.is_absolute()||path.filename()!=L"capture.f32le")throw Failure{"CALIBRATION_PATH_INVALID"};
  if(GetDriveTypeW(path.root_path().c_str())!=DRIVE_FIXED)throw Failure{"CALIBRATION_PATH_INVALID"};
  for(const auto &part:path)if(part==L".."||part==L".")throw Failure{"CALIBRATION_PATH_INVALID"};
  bool local=false;
  for(auto p=path.parent_path();!p.empty();p=p.parent_path()){
    const auto attributes=GetFileAttributesW(p.c_str());
    if(attributes==INVALID_FILE_ATTRIBUTES||(attributes&FILE_ATTRIBUTE_REPARSE_POINT))throw Failure{"CALIBRATION_PATH_INVALID"};
    auto name=p.filename().wstring();std::transform(name.begin(),name.end(),name.begin(),[](wchar_t c){return static_cast<wchar_t>(std::towlower(c));});if(name==L".local")local=true;
    if(p==p.parent_path())break;
  }
  if(!local)throw Failure{"CALIBRATION_PATH_INVALID"};return path;
}
static std::vector<unsigned char> CalRead(const std::filesystem::path &path){
  std::ifstream file(path,std::ios::binary|std::ios::ate);
  if(!file||file.tellg()<=0||file.tellg()>static_cast<std::streamoff>(atlas_cal::maxSamples*4))throw Failure{"CALIBRATION_PCM_INVALID"};
  const auto n=static_cast<size_t>(file.tellg());std::vector<unsigned char> bytes(n);file.seekg(0);
  if(!file.read(reinterpret_cast<char *>(bytes.data()),static_cast<std::streamsize>(n))){
    volatile unsigned char *p=bytes.data();for(size_t i=0;i<bytes.size();i++)p[i]=0;throw Failure{"CALIBRATION_PCM_INVALID"};
  }
  return bytes;
}
static std::string CalFileHash(const std::filesystem::path &path){
  auto bytes=CalRead(path);struct Wipe{std::vector<unsigned char>&b;~Wipe(){volatile unsigned char*p=b.data();for(size_t i=0;i<b.size();i++)p[i]=0;}}wipe{bytes};
  if(bytes.size()>atlas_cal::maxSamples*4)throw Failure{"CALIBRATION_PCM_INVALID"};return Hash(bytes.data(),bytes.size());
}
static void SaveCalibration(Shared &s){
  const auto path=CalPath(s.calPath);static_assert(sizeof(float)==4,"F32 required");
  HANDLE file=CreateFileW(path.c_str(),GENERIC_WRITE,0,nullptr,CREATE_NEW,FILE_ATTRIBUTE_NORMAL|FILE_FLAG_OPEN_REPARSE_POINT,nullptr);
  if(file==INVALID_HANDLE_VALUE)throw Failure{"CALIBRATION_WRITE_FAILED"};
  const DWORD n=static_cast<DWORD>(s.recording.size()*4);DWORD written=0;
  const bool ok=WriteFile(file,s.recording.data(),n,&written,nullptr)&&written==n&&FlushFileBuffers(file);
  const bool closed=CloseHandle(file)!=FALSE;if(!ok||!closed)throw Failure{"CALIBRATION_WRITE_FAILED"};
  s.calHash=Hash(reinterpret_cast<const unsigned char *>(s.recording.data()),n);
  if(CalFileHash(path)!=s.calHash)throw Failure{"PCM_HASH_MISMATCH"};s.calSamples=s.recording.size();s.calPersisted=true;
}
static void CalibrationReplay(Shared &s,Progress &progress) noexcept {
  try{
    const auto path=CalPath(s.calPath);const auto attributes=GetFileAttributesW(path.c_str());
    if(attributes==INVALID_FILE_ATTRIBUTES||(attributes&(FILE_ATTRIBUTE_REPARSE_POINT|FILE_ATTRIBUTE_DIRECTORY)))throw Failure{"CALIBRATION_PATH_INVALID"};
    if(std::filesystem::file_size(path)!=s.calSamples*4)throw Failure{"CALIBRATION_PCM_INVALID"};
    auto bytes=CalRead(path);struct Wipe{std::vector<unsigned char>&b;~Wipe(){volatile unsigned char *p=b.data();for(size_t i=0;i<b.size();i++)p[i]=0;}}wipe{bytes};
    if(bytes.size()!=s.calSamples*4||Hash(bytes.data(),bytes.size())!=s.calHash)throw Failure{"PCM_HASH_MISMATCH"};
    s.pcmHash=s.calHash;s.format={16000,1,4,32,live::Kind::float32};s.firTaps=1;
    live::Assembler assembler;const double start=Wall();s.started.store(true);progress.write("REPLAY_STARTED\n");
    for(size_t at=0;at<s.calSamples&&!stopped(s);at+=1600){
      const size_t n=std::min<size_t>(1600,s.calSamples-at);
      while(!stopped(s)&&Wall()<start+(at+n)/16.0)WaitForSingleObject(s.stop.h,1);
      if(stopped(s))break;s.frames+=n;
      for(size_t i=0;i<n;i++){
        float value=0;std::memcpy(&value,bytes.data()+(at+i)*4,4);if(!std::isfinite(value))throw Failure{"CALIBRATION_PCM_INVALID"};
        s.signal[0].add(value);s.outputSignal.add(value);s.convertedFrames++;s.emitted++;
        assembler.accept(value,start+(at+i+1)/16.0,[&](const live::Block &b){uint64_t pending=0;
          if(!s.queue.push(b,&pending)){s.overflows++;return false;}s.enqueued++;s.highWater.store(std::max(s.highWater.load(),pending));SetEvent(s.data.h);return true;});
      }
    }
    s.tail=assembler.tail();s.captureWallMs=Wall()-start;
    if(CalFileHash(path)!=s.calHash)throw Failure{"PCM_HASH_MISMATCH"};
  }catch(const Failure&e){s.fail(e.code);}catch(const live::Error&e){s.fail(e.code);}catch(...){s.fail("CALIBRATION_REPLAY_FAILED");}
  s.captureFinished.store(true,std::memory_order_release);SetEvent(s.captureDone.h);SetEvent(s.data.h);progress.write("REPLAY_STOPPED\n");
}

// Hash only authorized replay PCM at the actual Feed boundary, never microphone audio.
class ReplayHash {
  BCRYPT_HASH_HANDLE handle=nullptr;
 public:
  ReplayHash(){if(BCryptCreateHash(BCRYPT_SHA256_ALG_HANDLE,&handle,nullptr,0,nullptr,0,0)<0)throw Failure{"HASH_FAILED"};}
  void add(const float *samples,uint32_t count){if(BCryptHashData(handle,reinterpret_cast<PUCHAR>(const_cast<float *>(samples)),count*4,0)<0)throw Failure{"HASH_FAILED"};}
  std::string finish(){unsigned char digest[32]{};if(BCryptFinishHash(handle,digest,32,0)<0)throw Failure{"HASH_FAILED"};
    std::ostringstream out;out<<std::hex<<std::setfill('0');for(auto b:digest)out<<std::setw(2)<<static_cast<unsigned>(b);return out.str();}
  ~ReplayHash(){if(handle)BCryptDestroyHash(handle);}
};

static void Inference(Shared &s, char **argv, bool warm, Progress &progress, const double threshold) noexcept {
  try {
    {
      const double init = Wall();
      SherpaOnnxKeywordSpotterConfig c{};
      c.feat_config.sample_rate = 16000; c.feat_config.feature_dim = 80;
      c.model_config.transducer.encoder = argv[1]; c.model_config.transducer.decoder = argv[2]; c.model_config.transducer.joiner = argv[3]; c.model_config.tokens = argv[4];
      c.model_config.num_threads = 1; c.model_config.provider = "cpu";
      c.max_active_paths = 4; c.num_trailing_blanks = 1; c.keywords_score = 1; c.keywords_threshold = static_cast<float>(threshold);
      s.thresholdFloat32 = c.keywords_threshold;
      c.keywords_buf = argv[5]; c.keywords_buf_size = static_cast<int32_t>(std::strlen(argv[5]));
      using Spotter = std::unique_ptr<const SherpaOnnxKeywordSpotter, decltype(&SherpaOnnxDestroyKeywordSpotter)>;
      Spotter spotter(SherpaOnnxCreateKeywordSpotter(&c), SherpaOnnxDestroyKeywordSpotter);
      if (!spotter) throw Failure{"MODEL_LOAD_FAILED"};
      s.engineReleased = false;
      const SherpaOnnxOnlineStream *stream = SherpaOnnxCreateKeywordStream(spotter.get());
      if (!stream) throw Failure{"STREAM_FAILED"};
      struct Stream { const SherpaOnnxOnlineStream *&p; ~Stream() { if (p) SherpaOnnxDestroyOnlineStream(p); } } streamGuard{stream};
      s.initWallMs = Wall() - init; const double prep = Wall();
      if (warm) {
        progress.write("PREPARING\n"); Run synthetic; float silence[1600]{};
        while (synthetic.calls < 2 && s.warmBlocks < 30 && !stopped(s)) {
          if (Wall() - prep >= 10000) throw Failure{"WARMUP_TIMEOUT"};
          Feed(spotter.get(), stream, silence, 1600, s.warmBlocks * 1600, synthetic); s.warmBlocks++;
        }
        if (!stopped(s) && (synthetic.calls < 2 || Wall() - prep >= 10000)) throw Failure{"WARMUP_TIMEOUT"};
        s.warmDecodes = synthetic.calls;
        if (!stopped(s)) { const double reset = Wall(); ReplaceStream(spotter.get(), stream); s.resetWallMs = Wall() - reset; s.newStream = true; }
      }
      // Cold starts with the initial new stream; Warm confirms create-before-destroy.
      else s.newStream = true;
      s.preparationWallMs = Wall() - prep;
      s.memoryStart = Mem(); SetEvent(s.ready.h);
      std::unique_ptr<ReplayHash> replayHash;if(s.replay)replayHash=std::make_unique<ReplayHash>();
      uint64_t sequence = 0; double cpuTotal = 0; bool cpuAvailable = true;
      auto process = [&](live::Block &block) {
        struct Wipe { live::Block &b; ~Wipe() { b.wipe(); } } wipe{block};
        if (block.sequence != sequence++ || !block.size || block.size > 1600) { s.sequenceErrors++; throw Failure{"AUDIO_SEQUENCE_ERROR"}; }
        if(s.calSave)s.recording.append(block.pcm.data(),block.size,s.run.samples);
        if(replayHash)replayHash->add(block.pcm.data(),block.size);
        atlas_fn::Block *diagnostic=nullptr;
        if(s.fnEnabled){
          if(s.diagnosticBlocks.size()>=1300)throw Failure{"DIAGNOSTIC_LIMIT"};
          const double statsStart=Wall();atlas_fn::Block d;
          d.sequence=block.sequence;d.sampleStart=s.run.samples;d.sampleEnd=d.sampleStart+block.size;
          d.qpcEndMs=block.captureEndWallMs-s.fnOrigin;d.qpcStartMs=d.qpcEndMs-block.size/16.0;
          for(unsigned i=0;i<block.size;i++)d.signal.add(block.pcm[i]);
          d.metricsWallMs=Wall()-statsStart;s.diagnosticBlocks.push_back(d);diagnostic=&s.diagnosticBlocks.back();
        }
        const double start = Wall(), cpu = Cpu();
        s.maxQueueAgeMs = std::max(s.maxQueueAgeMs, start - block.captureEndWallMs);
        Feed(spotter.get(), stream, block.pcm.data(), block.size, s.run.samples, s.run,
          s.fnEnabled?+[](void *context,int sequence,double begin,double end){auto &state=*static_cast<Shared *>(context);
            if(state.diagnosticDecodes.size()>=10000)throw Failure{"DIAGNOSTIC_LIMIT"};
            state.diagnosticDecodes.push_back({sequence,begin-state.fnOrigin,end-state.fnOrigin});}:nullptr,&s);
        if(diagnostic){diagnostic->completed=true;diagnostic->decodeCalls=s.run.blocks.back().calls;diagnostic->rawHits=s.run.blocks.back().hits;}
        const double elapsed = Wall() - start, used = Delta(cpu);
        s.processWallMs += elapsed; if (used < 0) cpuAvailable = false; else cpuTotal += used;
        const double latency = Wall() - block.captureEndWallMs;
        s.maxBlockEndLatencyMs = std::max(s.maxBlockEndLatencyMs, latency);
        s.blockEndLatencies.push_back(latency);
        const auto memory = Mem(); if (memory.available) {
          const size_t window = std::min<size_t>(11, size_t(s.run.samples / 160000));
          s.residentWindows[window] = std::max(s.residentWindows[window], memory.rss);
        }
      };
      for (;;) {
        if (s.error.load()) break;
        live::Block block;
        if (s.queue.pop(block)) { process(block); continue; }
        if (s.captureFinished.load(std::memory_order_acquire)) {
          // CaptureDone publishes tail; recheck queue after acquiring completion.
          if (s.queue.pop(block)) { process(block); continue; }
          if (s.tail.size) process(s.tail); break;
        }
        if (WaitForSingleObject(s.ready.h, 0) == WAIT_OBJECT_0 && stopped(s) && !s.started) break;
        if (WaitForSingleObject(s.data.h, 100) == WAIT_FAILED) throw Failure{"INFERENCE_WAIT_FAILED"};
      }
      if(replayHash)s.processedPcmHash=replayHash->finish();
      s.inferenceCpuMs = cpuAvailable ? cpuTotal : -1; s.memoryEnd = Mem();
      const double release=Wall();SherpaOnnxDestroyOnlineStream(stream);stream=nullptr;spotter.reset();s.engineReleaseWallMs=Wall()-release;
    }
    s.engineReleased = true;
  } catch (const Failure &e) { s.fail(e.code); s.engineReleased = true; }
    catch (const atlas_cal::Error &e) {s.fail(e.code);s.engineReleased=true;}
    catch (...) { s.fail("INFERENCE_FAILED"); s.engineReleased = true; }
  s.memoryAfterCleanup = Mem(); SetEvent(s.ready.h); SetEvent(s.inferenceDone.h);
}

static double Percentile(std::vector<double> values, double fraction) {
  if (values.empty()) return -1;
  std::sort(values.begin(), values.end());
  if (fraction == .5 && values.size() % 2 == 0) return (values[values.size()/2-1] + values[values.size()/2]) / 2;
  return values[static_cast<size_t>(std::ceil(values.size() * fraction)) - 1];
}
static void PollStop(Shared &s, Progress *progress=nullptr) {
  if(s.fnEnabled&&progress&&progress->failed.load())s.fail("DIAGNOSTIC_CHANNEL_FAILED");
  const HANDLE input = GetStdHandle(STD_INPUT_HANDLE); if (!input || input == INVALID_HANDLE_VALUE) return;
  DWORD mode = 0;
  if (GetConsoleMode(input, &mode)) {
    DWORD available = 0; if (!GetNumberOfConsoleInputEvents(input, &available) || !available) return;
    INPUT_RECORD event{}; DWORD read = 0;
    if (ReadConsoleInputW(input, &event, 1, &read) && read && event.EventType == KEY_EVENT && event.Event.KeyEvent.bKeyDown
        && event.Event.KeyEvent.wVirtualKeyCode == VK_RETURN) { s.cancelled.store(true); SetEvent(s.stop.h); }
  } else {
    DWORD bytes = 0; if (!PeekNamedPipe(input, nullptr, 0, nullptr, &bytes, nullptr)) {
      const auto pipeError=GetLastError();
      if(GetFileType(input)==FILE_TYPE_PIPE && pipeError==ERROR_BROKEN_PIPE){s.cancelled.store(true);SetEvent(s.stop.h);}return;
    }
    if(bytes && s.fnEnabled && progress){
      char payload[256]{};DWORD count=0;
      if(!ReadFile(input,payload,std::min<DWORD>(bytes,256),&count,nullptr))throw Failure{"MARKER_PROTOCOL_INVALID"};
      for(DWORD i=0;i<count;i++){
        const char c=payload[i];
        if(c=='S'){s.cancelled.store(true);SetEvent(s.stop.h);s.markerInput.clear();return;}
        if(c=='\n'){
          if(!s.started.load()||s.captureFinished.load())throw Failure{"MARKER_NOT_ACTIVE"};
          atlas_fn::Marker marker;
          try{marker=s.receiver.accept(s.markerInput,s.trialId,Wall()-s.fnOrigin);}catch(const atlas_fn::Error &e){throw Failure{e.code};}
          s.markerInput.clear();s.markers.push_back(marker);
          std::ostringstream ack;ack.imbue(std::locale::classic());ack<<std::setprecision(17)<<"ACK "<<s.trialId<<' '<<marker.id<<' '<<marker.kind<<' '<<marker.qpcMs<<'\n';
          progress->write(ack.str().c_str());
        }else{if(c<' '||c>'~'||s.markerInput.size()>=80)throw Failure{"MARKER_PROTOCOL_INVALID"};s.markerInput+=c;}
      }
      return;
    }
    if (bytes) {
      char command = 0; DWORD count = 0;
      if (ReadFile(input, &command, 1, &count, nullptr) && count && command == 'S') { s.cancelled.store(true); SetEvent(s.stop.h); }
    }
  }
}
static void Report(Shared &s, const std::vector<Dll> &dlls, const std::vector<std::string> &hashes,
                   const std::string &keywordHash, bool warm, int seconds, bool detail, const double threshold) {
  auto &o = std::cout; o.imbue(std::locale::classic()); o << std::setprecision(17);
  std::vector<double> decode; for (auto d : s.run.decodes) decode.push_back(d.wall);
  const char *error = s.error.load();
  const bool complete = !error && !s.cancelled.load() && s.started && (s.replay ? s.run.samples == (s.calReplay?static_cast<int>(s.calSamples):330411) : s.captureWallMs >= seconds * 1000.0)
    && s.emitted == static_cast<uint64_t>(s.run.samples) && s.captureReleased && s.comReleased && s.engineReleased;
  o << "{\"schema\":1,\"backend\":\"NATIVE_LIVE\",\"source\":\""<<(s.replay?"REPLAY":"MICROPHONE")<<"\",\"state\":\"" << (error ? "FAILED" : complete ? "COMPLETED" : "CANCELLED")
    << "\",\"code\":\"" << (error ? error : complete ? "CAPTURE_COMPLETED" : "CAPTURE_INCOMPLETE") << "\",\"mode\":\"" << (warm ? "WARM" : "COLD")
    << "\",\"runtime\":{\"version\":\"2.0.0\",\"dlls\":[";
  for (size_t i=0;i<dlls.size();i++) { if(i)o<<','; o<<"{\"name\":\""<<dlls[i].name<<"\",\"sha256\":\""<<dlls[i].hash<<"\"}"; }
  o<<"]},\"wavSha256\":";if(s.wavHash.empty())o<<"null";else o<<'"'<<s.wavHash<<'"';o<<",\"pcmSha256\":";if(s.pcmHash.empty())o<<"null";else o<<'"'<<s.pcmHash<<'"';o<<",\"processedPcmSha256\":";if(s.processedPcmHash.empty())o<<"null";else o<<'"'<<s.processedPcmHash<<'"';o<<",\"modelHashes\":{"; const char *names[]{"encoder.onnx","decoder.onnx","joiner.onnx","tokens.txt"};
  for(int i=0;i<4;i++){if(i)o<<',';o<<'"'<<names[i]<<"\":\""<<hashes[i]<<'"';}
  o<<"},\"keywordSha256\":\""<<keywordHash<<"\",\"configuration\":{\"threshold\":"<<threshold<<",\"score\":1,\"maxActivePaths\":4,\"cooldownMs\":1000,\"sampleRate\":16000,\"channels\":1,\"blockSamples\":1600,\"numTrailingBlanks\":1,\"featureDim\":80},";
  o<<"\"thresholdEvidence\":{\"spotterArgumentFloat32\":";Number(o,s.thresholdFloat32);o<<"},";
  const char *kind = s.format.kind==live::Kind::pcm16?"PCM16":s.format.kind==live::Kind::pcm24?"PCM24":s.format.kind==live::Kind::pcm32?"PCM32":s.format.kind==live::Kind::float64?"FLOAT64":"FLOAT32";
  o<<"\"format\":{\"rate\":"<<s.format.rate<<",\"channels\":"<<s.format.channels<<",\"containerBits\":"<<s.format.bytes*8<<",\"validBits\":"<<s.format.validBits<<",\"kind\":\""<<kind<<"\",\"selectedChannel\":0,\"endpointBufferFrames\":"<<s.endpointFrames<<"},"
    <<"\"conversion\":{\"outputRate\":16000,\"firTaps\":"<<s.firTaps<<",\"filterDelayMs\":"<<s.filterDelayMs<<",\"outputRms\":"<<s.outputSignal.rms()<<",\"outputPeak\":"<<s.outputSignal.peak<<",\"outputClipped\":"<<s.outputSignal.clipped<<",\"appendedSamples\":0},"
    <<"\"capture\":{\"requestedSeconds\":"<<seconds<<",\"wallMs\":"<<s.captureWallMs<<",\"framesReceived\":"<<s.frames<<",\"framesConverted\":"<<s.convertedFrames<<",\"unconvertedFrames\":"<<(s.frames-s.convertedFrames)<<",\"resampledSamples\":"<<s.emitted<<",\"enqueuedBlocks\":"<<s.enqueued<<",\"processedSamples\":"<<s.run.samples<<",\"processedBlocks\":"<<s.run.blocks.size()<<",\"silentFrames\":"<<s.silentFrames
    <<",\"unprocessedSamples\":"<<(s.emitted-s.run.samples)<<",\"overflows\":"<<s.overflows<<",\"discontinuities\":"<<s.continuity.discontinuities<<",\"initialDiscontinuities\":"<<s.continuity.initialDiscontinuities<<",\"sequenceErrors\":"<<s.sequenceErrors<<"},"
    <<"\"buffer\":{\"queuedCapacity\":4,\"decoderBlocks\":1,\"assemblerBlocks\":1,\"highWater\":"<<s.highWater.load()<<",\"pendingAfterCleanup\":"<<s.queue.pending()<<",\"abandonedBlocksOnFailure\":"<<s.abandonedBlocks<<",\"maxQueueAgeMs\":"<<std::max(0.0,s.maxQueueAgeMs)<<",\"maxBlockEndLatencyMs\":"<<std::max(0.0,s.maxBlockEndLatencyMs)<<"},"
    <<"\"preparation\":{\"initializationWallMs\":"<<s.initWallMs<<",\"wallMs\":"<<s.preparationWallMs<<",\"resetWallMs\":"<<s.resetWallMs<<",\"syntheticBlocks\":"<<s.warmBlocks<<",\"decodeCalls\":"<<s.warmDecodes<<",\"newStream\":"<<(s.newStream?"true":"false")<<"},"
    <<"\"inference\":{\"decodeCalls\":"<<decode.size()<<",\"firstDecodeWallMs\":"; Number(o,decode.empty()?-1:decode.front());
  o<<",\"medianDecodeWallMs\":";Number(o,Percentile(decode,.5));o<<",\"p95DecodeWallMs\":";Number(o,Percentile(decode,.95));o<<",\"maxDecodeWallMs\":";Number(o,decode.empty()?-1:*std::max_element(decode.begin(),decode.end()));
  o<<",\"maxBlockWallMs\":"<<s.run.maxBlock<<",\"processingWallMs\":"<<s.processWallMs<<",\"threadCpuMs\":";Number(o,s.inferenceCpuMs);o<<",\"rtf\":";Number(o,s.run.samples?s.processWallMs/(s.run.samples/16.0):-1);o<<"},"
    <<"\"recognition\":{\"rawHits\":"<<s.run.raw<<",\"detections\":"<<s.run.detected<<",\"suppressedHits\":"<<s.run.suppressed<<"},\"channels\":[";
  for(uint32_t i=0;i<s.format.channels;i++){if(i)o<<',';auto &m=s.signal[i];o<<"{\"channel\":"<<i<<",\"samples\":"<<m.samples<<",\"rms\":"<<m.rms()<<",\"peak\":"<<m.peak<<",\"clipped\":"<<m.clipped<<",\"nearZero\":"<<m.nearZero<<'}';}
  o<<"],\"memory\":{\"residentStartBytes\":";Number(o,s.memoryStart.available?double(s.memoryStart.rss):-1);o<<",\"residentEndBytes\":";Number(o,s.memoryEnd.available?double(s.memoryEnd.rss):-1);
  o<<",\"peakResidentBytes\":";Number(o,s.memoryAfterCleanup.available?double(s.memoryAfterCleanup.peak):-1);o<<",\"residentAfterCleanupBytes\":";Number(o,s.memoryAfterCleanup.available?double(s.memoryAfterCleanup.rss):-1);
  o<<",\"residentWindows10s\":[";for(size_t i=0;i<s.residentWindows.size();i++){if(i)o<<',';if(s.residentWindows[i])o<<s.residentWindows[i];else o<<"null";}o<<"]},"
    <<"\"cleanup\":{\"microphoneReleased\":"<<(s.captureReleased?"true":"false")<<",\"comReleased\":"<<(s.comReleased?"true":"false")<<",\"engineReleased\":"<<(s.engineReleased?"true":"false")<<",\"threadsJoined\":true,\"wallMs\":"<<s.cleanupWallMs<<",\"microphoneReleaseWallMs\":";Number(o,s.micReleaseWallMs);o<<",\"engineReleaseWallMs\":";Number(o,s.engineReleaseWallMs);o<<"},"
    <<"\"positions\":[";
  for(size_t i=0;i<s.run.positions.size();i++){const auto &p=s.run.positions[i];const bool blockComplete=size_t(p.block)<s.blockEndLatencies.size();if(i)o<<',';o<<"{\"block\":"<<p.block<<",\"blockCompleted\":"<<(blockComplete?"true":"false")<<",\"audioSampleEnd\":";Number(o,blockComplete?std::min((p.block+1)*1600,s.run.samples):-1);o<<",\"startTimeSec\":"<<p.start<<",\"timestampsSec\":[";
    for(size_t j=0;j<p.timestamps.size();j++){if(j)o<<',';o<<p.timestamps[j];}o<<"],\"latencyFromBlockEndMs\":";Number(o,blockComplete?std::max(0.0,s.blockEndLatencies[p.block]):-1);o<<",\"acousticLatencyMs\":null}";}
  o<<"],\"details\":";
  if(!detail)o<<"null";else{o<<"{\"decodes\":[";for(size_t i=0;i<s.run.decodes.size();i++){if(i)o<<',';auto d=s.run.decodes[i];o<<"{\"block\":"<<d.block<<",\"wallMs\":"<<d.wall<<",\"threadCpuMs\":";Number(o,d.cpu);o<<'}';}o<<"],\"blocks\":[";
    for(size_t i=0;i<s.run.blocks.size();i++){if(i)o<<',';auto b=s.run.blocks[i];o<<"{\"sequence\":"<<b.sequence<<",\"wallMs\":"<<b.wall<<",\"decodeCalls\":"<<b.calls<<",\"rawHits\":"<<b.hits<<'}';}o<<"]}";}
  if(s.calSave||s.calReplay)o<<",\"calibration\":{\"schema\":1,\"mode\":\""<<(s.calSave?"CAPTURE":"REPLAY")<<"\",\"samples\":"<<s.calSamples<<",\"sha256\":\""<<s.calHash<<"\",\"persisted\":"<<(s.calPersisted?"true":"false")<<'}';
  if(s.fnEnabled){
    o<<",\"fnDiagnostics\":{\"schema\":1,\"trialId\":\""<<s.trialId<<"\",\"clock\":\"QPC_RELATIVE_MS\",\"signalDomain\":\"POST_FIR_MONO_16000\",\"channelHealthy\":"<<(s.fnChannelHealthy?"true":"false")<<",\"blocks\":[";
    for(size_t i=0;i<s.diagnosticBlocks.size();i++){if(i)o<<',';const auto &b=s.diagnosticBlocks[i];const auto &m=b.signal;
      o<<"{\"sequence\":"<<b.sequence<<",\"sampleStart\":"<<b.sampleStart<<",\"sampleEnd\":"<<b.sampleEnd<<",\"qpcStartMs\":"<<b.qpcStartMs<<",\"qpcEndMs\":"<<b.qpcEndMs
       <<",\"samples\":"<<m.samples<<",\"sumSquares\":"<<m.sumSquares<<",\"rms\":"<<m.rms()<<",\"peak\":"<<m.peak<<",\"nearZero\":"<<m.nearZero<<",\"clipped\":"<<m.clipped<<",\"invalid\":"<<m.invalid
       <<",\"metricsWallMs\":"<<b.metricsWallMs<<",\"completed\":"<<(b.completed?"true":"false")<<",\"decodeCalls\":"<<b.decodeCalls<<",\"rawHits\":"<<b.rawHits<<'}';}
    o<<"],\"decodes\":[";
    for(size_t i=0;i<s.diagnosticDecodes.size();i++){if(i)o<<',';const auto &d=s.diagnosticDecodes[i];o<<"{\"block\":"<<d.block<<",\"startMs\":"<<d.startMs<<",\"endMs\":"<<d.endMs<<'}';}
    o<<"],\"markers\":[";
    for(size_t i=0;i<s.markers.size();i++){if(i)o<<',';const auto &m=s.markers[i];o<<"{\"id\":"<<m.id<<",\"kind\":\""<<m.kind<<"\",\"qpcMs\":"<<m.qpcMs<<'}';}o<<"]}";
  }
  o<<'}'<<std::endl;
}

static int NativeLive(int argc, char **argv, Progress &progress) {
  const char *replay=nullptr,*trial=nullptr,*calReplay=nullptr,*calSave=nullptr,*calCount=nullptr,*calSha=nullptr,*consent=nullptr,*calKind=nullptr;bool detail=false,thresholdSpecified=false;double parsedThreshold=.25;
  for(int i=8;i<argc;i++){
    if(!std::strcmp(argv[i],"--detail")&&!detail)detail=true;
    else if(!std::strcmp(argv[i],"--replay")&&!replay&&i+1<argc)replay=argv[++i];
    else if(!std::strcmp(argv[i],"--calibration-replay")&&!calReplay&&i+1<argc)calReplay=argv[++i];
    else if(!std::strcmp(argv[i],"--calibration-save")&&!calSave&&i+1<argc)calSave=argv[++i];
    else if(!std::strcmp(argv[i],"--calibration-samples")&&!calCount&&i+1<argc)calCount=argv[++i];
    else if(!std::strcmp(argv[i],"--calibration-sha")&&!calSha&&i+1<argc)calSha=argv[++i];
    else if(!std::strcmp(argv[i],"--calibration-kind")&&!calKind&&i+1<argc)calKind=argv[++i];
    else if(!std::strcmp(argv[i],"--capture-consent")&&!consent&&i+1<argc)consent=argv[++i];
    else if(!std::strcmp(argv[i],"--diagnostic-windows")&&!trial&&i+1<argc)trial=argv[++i];
    else if(!std::strcmp(argv[i],"--threshold")&&!thresholdSpecified&&i+1<argc){parsedThreshold=ParseLiveThreshold(argv[++i]);thresholdSpecified=true;}
    else throw Failure{"ARGUMENT_INVALID"};
  }
  const double threshold=parsedThreshold;
  if(replay && threshold!=.25)throw Failure{"ARGUMENT_INVALID"};
  if(argc<8)throw Failure{"ARGUMENT_INVALID"};
  const bool warm = !std::strcmp(argv[6],"WARM");
  if (!warm && std::strcmp(argv[6],"COLD")) throw Failure{"ARGUMENT_INVALID"};
  char *end = nullptr; const long seconds = std::strtol(argv[7],&end,10);
  if (!end || *end || seconds<1 || seconds>120 || std::strcmp(argv[5],LiveKeyword(threshold).c_str())) throw Failure{"ARGUMENT_INVALID"};
  if(trial&&(!atlas_fn::trialId(trial)||warm||replay||threshold!=.15||(seconds!=60&&!(calSave&&seconds==120))))throw Failure{"ARGUMENT_INVALID"};
  size_t calSamples=0;
  if(calReplay){
    if(replay||calSave||trial||consent||warm||threshold==.25||!calCount||!calSha||std::strlen(calSha)!=64||std::strspn(calSha,"0123456789abcdef")!=64)throw Failure{"ARGUMENT_INVALID"};
    char *tail=nullptr;const unsigned long n=std::strtoul(calCount,&tail,10);
    if(!n||n>atlas_cal::maxSamples||!tail||*tail||std::to_string(n)!=calCount)throw Failure{"ARGUMENT_INVALID"};calSamples=n;CalPath(calReplay);
  }else if(calCount||calSha)throw Failure{"ARGUMENT_INVALID"};
  if(calSave&&(!trial||!consent||std::strcmp(consent,trial)||warm||replay||calReplay||threshold!=.15||(seconds!=60&&seconds!=120)))throw Failure{"ARGUMENT_INVALID"};
  if(calKind&&!calSave)throw Failure{"ARGUMENT_INVALID"};
  if(calSave){
    if(calKind){try{if(seconds!=atlas_cal::captureSeconds(calKind))throw Failure{"ARGUMENT_INVALID"};}catch(const atlas_cal::Error &){throw Failure{"ARGUMENT_INVALID"};}}
    else if(seconds!=60)throw Failure{"ARGUMENT_INVALID"};
  }
  if(consent&&!calSave)throw Failure{"ARGUMENT_INVALID"};
  const auto dlls = LoadedDlls();
  const std::string version=SherpaOnnxGetVersionStr(),git=SherpaOnnxGetGitSha1();
  if(version!="2.0.0" || git.substr(0,8)!="8abb7c8f")throw Failure{"RUNTIME_VERSION_MISMATCH"};
  const char *expected[]{"949e720ba4282d1097025d1f469317e16c06c69820d0384acd648cd12fcba983","422d776ab0e3218260f7f628fcb84606aaa5c21116f720c8619a6da5e0b2e0f9"};
  if(dlls.size()!=2 || dlls[0].hash!=expected[0] || dlls[1].hash!=expected[1])throw Failure{"SDK_HASH_MISMATCH"};
  std::vector<std::string> hashes;for(int i=1;i<=4;i++)hashes.push_back(FileHash(std::filesystem::u8path(argv[i])));
  const std::string keyword=argv[5],keywordHash=Hash(reinterpret_cast<const unsigned char *>(keyword.data()),keyword.size());
  Shared s;s.replay=replay!=nullptr||calReplay!=nullptr;
  if(calSave){CalPath(calSave);s.calSave=true;s.calPath=calSave;s.recording.prepare(seconds==120?atlas_cal::maxSamples:atlas_cal::shortMaxSamples);}
  if(calReplay){s.calReplay=true;s.calPath=calReplay;s.calSamples=calSamples;s.calHash=calSha;}
  if(trial){s.fnEnabled=true;s.trialId=trial;s.fnOrigin=Wall();s.markers.reserve(40);s.diagnosticBlocks.reserve(1300);s.diagnosticDecodes.reserve(10000);progress.startAsync();}controlState.store(&s);
  if(!SetConsoleCtrlHandler(Control,TRUE)){controlState.store(nullptr);throw Failure{"CONTROL_HANDLER_FAILED"};}
  struct ControlGuard {~ControlGuard(){controlState.store(nullptr);SetConsoleCtrlHandler(Control,FALSE);while(controlCalls.load())std::this_thread::yield();}} controlGuard;
  std::thread inference;
  std::thread capture;
  try {
    inference=std::thread([&]{Inference(s,argv,warm,progress,threshold);});
    const double begin=Wall();
    DWORD readyWait=0;
    while((readyWait=WaitForSingleObject(s.ready.h,20))==WAIT_TIMEOUT && !stopped(s)){
      PollStop(s,&progress);if(Wall()-begin>30000)s.fail("PREPARATION_TIMEOUT");
    }
    if(readyWait==WAIT_FAILED)s.fail("CONTROL_WAIT_FAILED");
    if(!stopped(s))capture=std::thread([&]{if(calReplay)CalibrationReplay(s,progress);else if(replay)Replay(s,replay,progress);else Capture(s,static_cast<int>(seconds),progress);});
    else {s.captureFinished.store(true,std::memory_order_release);SetEvent(s.captureDone.h);}
    DWORD doneWait=0;while((doneWait=WaitForSingleObject(s.inferenceDone.h,20))==WAIT_TIMEOUT)PollStop(s,&progress);
    if(doneWait==WAIT_FAILED)s.fail("CONTROL_WAIT_FAILED");
  }catch(const Failure &e){s.fail(e.code);if(!capture.joinable()){s.captureFinished.store(true,std::memory_order_release);SetEvent(s.captureDone.h);}}
  catch(...){s.fail("THREAD_OR_CONTROL_FAILED");if(!capture.joinable()){s.captureFinished.store(true,std::memory_order_release);SetEvent(s.captureDone.h);}}
  double cleanup=0;try{cleanup=Wall();}catch(...){s.fail("CAPTURE_CLOCK_FAILED");}SetEvent(s.stop.h);SetEvent(s.data.h);
  if(capture.joinable())capture.join();if(inference.joinable())inference.join();
  s.abandonedBlocks=s.queue.pending();s.queue.wipeAfterJoin();s.tail.wipe();
  try{s.cleanupWallMs=Wall()-cleanup;}catch(...){s.fail("CAPTURE_CLOCK_FAILED");}s.memoryAfterCleanup=Mem();
  if(!s.error.load() && (s.frames!=s.convertedFrames || (s.format.rate && s.emitted!=s.frames*16000/s.format.rate) || s.emitted!=uint64_t(s.run.samples)))s.fail("AUDIO_ACCOUNTING_FAILED");
  if(s.fnEnabled){s.fnChannelHealthy=progress.finish();if(!s.fnChannelHealthy)s.fail("DIAGNOSTIC_CHANNEL_FAILED");}
  if(s.calSave&&!s.error.load()&&!s.cancelled.load()&&s.captureWallMs>=seconds*1000.0&&s.captureReleased&&s.comReleased&&s.engineReleased){
    try{if(s.recording.size()!=static_cast<size_t>(s.run.samples))throw Failure{"CALIBRATION_SEQUENCE_INVALID"};SaveCalibration(s);}
    catch(const Failure&e){s.fail(e.code);}catch(...){s.fail("CALIBRATION_WRITE_FAILED");}
  }
  s.recording.wipe();if(s.calSave)s.memoryAfterCleanup=Mem();
  Report(s,dlls,hashes,keywordHash,warm,static_cast<int>(seconds),detail,threshold);
  return s.error.load()?2:s.cancelled.load()?130:0;
}
int wmain(int argc,wchar_t **wide) {
  Progress progress;
  try {
    if(!progress.muted || !progress.handle)throw Failure{"DIAGNOSTIC_CHANNEL_UNAVAILABLE"};
    std::vector<std::string> text;text.reserve(argc);
    for(int i=0;i<argc;i++){const int n=WideCharToMultiByte(CP_UTF8,WC_ERR_INVALID_CHARS,wide[i],-1,nullptr,0,nullptr,nullptr);if(n<=0)throw Failure{"ARGUMENT_INVALID"};std::string value(n,'\0');if(!WideCharToMultiByte(CP_UTF8,WC_ERR_INVALID_CHARS,wide[i],-1,value.data(),n,nullptr,nullptr))throw Failure{"ARGUMENT_INVALID"};value.pop_back();text.push_back(std::move(value));}
    std::vector<char *> args;for(auto &value:text)args.push_back(value.data());return NativeLive(argc,args.data(),progress);
  }catch(const Failure &e){std::cout<<"{\"schema\":1,\"state\":\"FAILED\",\"code\":\""<<e.code<<"\"}"<<std::endl;return 2;}
    catch(...){std::cout<<"{\"schema\":1,\"state\":\"FAILED\",\"code\":\"NATIVE_LIVE_FAILED\"}"<<std::endl;return 2;}
}
#else
int main(){std::cout<<"{\"state\":\"FAILED\",\"code\":\"WINDOWS_REQUIRED\"}"<<std::endl;return 2;}
#endif

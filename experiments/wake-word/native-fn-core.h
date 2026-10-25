// Experimental diagnostics only; no PCM retention or capture/inference synchronization.
#pragma once
#include <array>
#include <atomic>
#include <cmath>
#include <cstring>
#include <string>
#include <sstream>
#include <cstdint>

namespace atlas_fn {
struct Error { const char *code; };
struct Signal {
  uint32_t samples=0,nearZero=0,clipped=0,invalid=0;
  double sumSquares=0,peak=0;
  void add(float value){samples++;if(!std::isfinite(value)){invalid++;return;}
    const double a=std::abs(double(value));sumSquares+=double(value)*value;
    if(a>peak){peak=a;}
    nearZero+=a<1e-5;clipped+=a>=.999;}
  double rms()const{return samples?std::sqrt(sumSquares/samples):0;}
};
// 64 records, never reused during a trial. MPSC producers do bounded work only:
// one fetch_add, memcpy and release store, no spin, mutex, I/O or wait.
class LogQueue {
  struct Slot{std::array<char,128> text{};std::atomic<bool> ready{false};};
  std::array<Slot,64> slots_{};
  std::atomic<unsigned> count_{0};unsigned next_=0;
 public:
  static_assert(std::atomic<unsigned>::is_always_lock_free && std::atomic<bool>::is_always_lock_free,"Lock-free metadata producers required");
  bool push(const char *text){const auto n=std::strlen(text);if(n>=128)return false;
    const unsigned i=count_.fetch_add(1);if(i>=slots_.size())return false;
    std::memcpy(slots_[i].text.data(),text,n+1);slots_[i].ready.store(true,std::memory_order_release);return true;}
  bool pop(std::array<char,128>&out){if(next_>=slots_.size()||!slots_[next_].ready.load(std::memory_order_acquire))return false;
    out=slots_[next_++].text;return true;}
  bool drained()const{return next_==count_.load();}
};
inline bool trialId(const std::string &s){return s.size()==32&&s.find_first_not_of("0123456789abcdef")==std::string::npos;}
struct Marker{unsigned id;char kind;double qpcMs;};
class Receiver {
  unsigned next_=1;
 public:
  Marker accept(const std::string &line,const std::string &trial,double qpcMs){
    std::istringstream in(line);std::string prefix,idText,kind,nonce,extra;unsigned id=0;
    if(!(in>>prefix>>nonce>>idText>>kind)||in>>extra||prefix!="M"||nonce!=trial||!trialId(nonce)
      ||idText.empty()||idText.size()>2||idText.find_first_not_of("0123456789")!=std::string::npos)throw Error{"MARKER_PROTOCOL_INVALID"};
    for(char c:idText)id=id*10+unsigned(c-'0');
    if(id!=next_||id>40||std::to_string(id)!=idText||kind!=(id%2?"B":"E")
      ||line!="M "+nonce+" "+idText+" "+kind||!std::isfinite(qpcMs)||qpcMs<0)throw Error{"MARKER_PROTOCOL_INVALID"};
    next_++;return {id,kind[0],qpcMs};
  }
};
struct Block {
  uint64_t sequence=0,sampleStart=0,sampleEnd=0;
  double qpcStartMs=0,qpcEndMs=0,metricsWallMs=0;
  Signal signal;
  bool completed=false;
  unsigned decodeCalls=0,rawHits=0;
};
struct Decode{int block;double startMs,endMs;};
} // namespace atlas_fn

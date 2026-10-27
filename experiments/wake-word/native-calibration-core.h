// Experimental post-FIR tap. No capture thread, audio queue or FIR changes.
#pragma once
#include <vector>
#include <cstring>
#include <cmath>
#include <cstdint>
namespace atlas_cal {
constexpr size_t shortMaxSamples=64*16000;
constexpr size_t maxSamples=124*16000; // Historical 120 s bound.
constexpr size_t longMaxSamples=184*16000;
struct Error {const char *code;};
inline size_t sampleLimit(int seconds){
  if(seconds==60)return shortMaxSamples;
  if(seconds==120)return maxSamples;
  if(seconds==180)return longMaxSamples;
  throw Error{"CALIBRATION_SEQUENCE_INVALID"};
}
inline int captureSeconds(const char *kind){
  if(kind&&!std::strcmp(kind,"SILENCE"))return 60;
  if(kind&&(!std::strcmp(kind,"POSITIVE")||!std::strcmp(kind,"SIMILAR")))return 180;
  throw Error{"CALIBRATION_KIND_INVALID"};
}
// Replay-producer gate only. Queue implementation and single-attempt push are unchanged.
struct CapacityWait {
  uint64_t count=0;double totalMs=0,maxMs=0;
  template<class Pending,class Stopped,class Clock,class Wait>
  bool beforeBlock(Pending pending,Stopped stopped,Clock clock,Wait wait,double deadline){
    if(stopped())return false;
    if(clock()>=deadline)throw Error{"CALIBRATION_REPLAY_TIMEOUT"};
    if(pending()<4)return true;
    const double start=clock();count++;
    try{
      while(pending()>=4&&!stopped()){
        if(clock()>=deadline)throw Error{"CALIBRATION_REPLAY_TIMEOUT"};
        wait(); // kernel wait in Windows; virtual clock in portable tests
      }
    }catch(...){record(clock()-start);throw;}
    record(clock()-start);
    if(stopped())return false;
    if(clock()>=deadline)throw Error{"CALIBRATION_REPLAY_TIMEOUT"};
    return true;
  }
  void record(double elapsed){totalMs+=elapsed;if(elapsed>maxMs)maxMs=elapsed;}
};
class Buffer {
  std::vector<float> values;
  size_t limit=shortMaxSamples;
 public:
  void prepare(size_t maximum=shortMaxSamples){
    if(maximum!=shortMaxSamples&&maximum!=maxSamples&&maximum!=longMaxSamples)throw Error{"CALIBRATION_SEQUENCE_INVALID"};
    limit=maximum;values.reserve(limit);
  }
  void append(const float *pcm,size_t count,size_t offset){
    if(offset!=values.size()||!count||count>1600||values.size()+count>limit)throw Error{"CALIBRATION_SEQUENCE_INVALID"};
    for(size_t i=0;i<count;i++)if(!std::isfinite(pcm[i]))throw Error{"CALIBRATION_PCM_INVALID"};
    const auto begin=values.size();values.resize(begin+count);std::memcpy(values.data()+begin,pcm,count*sizeof(float));
  }
  const float *data()const{return values.data();}
  size_t size()const{return values.size();}
  void wipe(){volatile unsigned char *p=reinterpret_cast<volatile unsigned char *>(values.data());
    for(size_t i=0;i<values.size()*sizeof(float);i++){p[i]=0;}
    values.clear();}
  ~Buffer(){wipe();}
};
} // namespace atlas_cal

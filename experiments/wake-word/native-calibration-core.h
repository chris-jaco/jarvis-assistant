// Experimental post-FIR tap. No capture thread, audio queue or FIR changes.
#pragma once
#include <vector>
#include <cstring>
#include <cmath>
#include <cstdint>
namespace atlas_cal {
constexpr size_t maxSamples=64*16000;
struct Error {const char *code;};
class Buffer {
  std::vector<float> values;
 public:
  void prepare(){values.reserve(maxSamples);}
  void append(const float *pcm,size_t count,size_t offset){
    if(offset!=values.size()||!count||count>1600||values.size()+count>maxSamples)throw Error{"CALIBRATION_SEQUENCE_INVALID"};
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

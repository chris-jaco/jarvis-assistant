#include "native-live-core.h"
#include <iostream>
#include <stdexcept>
#include <thread>
using namespace atlas_live;
static void require(bool condition) { if (!condition) throw std::runtime_error("CORE_TEST_FAILED"); }
template<class F> static void rejects(F f, const char *code) {
  try { f(); } catch (const Error &e) { require(std::strcmp(e.code,code)==0); return; }
  throw std::runtime_error("EXPECTED_REJECTION");
}
static std::vector<float> convert(uint32_t rate, const std::vector<float> &input, size_t packet) {
  Resampler r(rate); std::vector<float> out;
  for(size_t at=0;at<input.size();at+=packet)for(size_t j=at;j<std::min(at+packet,input.size());j++)r.accept(input[j],[&](float v){out.push_back(v);});
  require(r.received()==input.size());require(r.emitted()==input.size()*16000/rate);return out;
}
int main() {
  try {
    unsigned checks=0;
    for(auto rate:{16000u,32000u,44100u,48000u,88200u,96000u,176400u,192000u}){
      std::vector<float> input(rate/5+17);
      for(size_t i=0;i<input.size();i++)input[i]=float(.3*std::sin(i*.173));
      const auto expected=convert(rate,input,input.size());
      for(auto packet:{1u,7u,128u,480u,1600u}){
        const auto result=convert(rate,input,packet);
        require(result.size()==expected.size());require(std::memcmp(result.data(),expected.data(),result.size()*4)==0);checks++;
      }
    }
    {const std::vector<float> input{0.f,-0.f,.5f,-1.f,.999f};auto out=convert(16000,input,2);
      require(std::memcmp(input.data(),out.data(),input.size()*4)==0);checks++;}
    for(auto rate:{32000u,44100u,48000u,88200u,96000u,176400u,192000u}){
      auto amplitude=[&](double hz){std::vector<float> pcm(rate/2);for(size_t i=0;i<pcm.size();i++)pcm[i]=float(std::sin(6.283185307179586*hz*i/rate));
        const auto out=convert(rate,pcm,137);double squares=0;for(size_t i=400;i<out.size();i++)squares+=double(out[i])*out[i];return std::sqrt(squares/(out.size()-400));};
      require(amplitude(1000)>.70);require(amplitude(8400)<.001);require(amplitude(12000)<.001);checks++;
    }
    {Resampler r(48000);for(int i=0;i<960;i++)r.accept(0,[](float x){require(x==0);});require(r.emitted()==320);checks++;}
    rejects([]{Resampler r(22050);},"CAPTURE_FORMAT_UNSUPPORTED");
    rejects([]{Resampler r(48000);r.accept(NAN,[](float){});},"CAPTURE_SAMPLE_INVALID");
    rejects([]{validate({48000,0,4,32,Kind::float32});},"CAPTURE_FORMAT_UNSUPPORTED");
    rejects([]{validate({48000,2,4,24,Kind::float32});},"CAPTURE_FORMAT_UNSUPPORTED");checks+=4;
    {Signal left,right;for(int i=0;i<100;i++){left.add(.1f);right.add(.001f);}require(left.rms()>right.rms()*90);require(left.peak>.09);require(left.clipped==0);
      left.add(1);require(left.clipped==1);float nan=NAN;rejects([&]{sample(reinterpret_cast<unsigned char *>(&nan),Kind::float32);},"CAPTURE_SAMPLE_INVALID");
      unsigned char low24[]{0,0,128},hi24[]{255,255,127};require(sample(low24,Kind::pcm24)==-1);require(sample(hi24,Kind::pcm24)>.999);checks++;}
    {Queue q;Block b;b.size=1600;for(int i=0;i<4;i++){b.sequence=i;require(q.push(b));}require(!q.push(b));require(q.pending()==4);
      q.wipeAfterJoin();require(q.pending()==0);require(!q.pop(b));
      for(int i=0;i<4;i++){b.sequence=i;require(q.push(b));}
      for(int i=0;i<4;i++){Block out;require(q.pop(out));require(out.sequence==uint64_t(i));}require(!q.pop(b));checks++;}
    {Queue q;std::atomic<bool> done{false};std::thread producer([&]{Block b;b.size=1600;for(int i=0;i<10000;i++){b.sequence=i;b.pcm[0]=float(i);while(!q.push(b))std::this_thread::yield();}done.store(true);});
      uint64_t next=0;while(!done.load()||q.pending()){Block b;if(q.pop(b)){require(b.sequence==next++);require(b.pcm[0]==float(b.sequence));}else std::this_thread::yield();}
      producer.join();require(next==10000);checks++;}
    {Assembler assembler;std::vector<Block> out;for(int i=0;i<330411;i++)assembler.accept(float(i%10)/10,i,[&](const Block &b){out.push_back(b);return true;});
      auto tail=assembler.tail();require(out.size()==206);require(tail.size==811);require(tail.sequence==206);
      uint64_t total=0;for(auto &block:out){require(block.sequence==total/1600);for(unsigned j=0;j<block.size;j++)require(block.pcm[j]==float((total+j)%10)/10);total+=block.size;}
      for(unsigned j=0;j<tail.size;j++){require(tail.pcm[j]==float((total+j)%10)/10);}
      require(total+tail.size==330411);checks++;}
    {Assembler a;rejects([&]{for(int i=0;i<1600;i++)a.accept(.1f,0,[](const Block &){return false;});},"AUDIO_OVERFLOW");rejects([&]{a.accept(.1f,0,[](const Block &){return true;});},"ASSEMBLER_STOPPED");checks++;}
    {Continuity c;c.packet(500,480,true,false);c.packet(980,480,false,false);require(c.initialDiscontinuities==1);require(c.discontinuities==0);
      rejects([&]{c.packet(1500,480,false,false);},"CAPTURE_DISCONTINUITY");
      Continuity d;d.packet(0,480,false,false);rejects([&]{d.packet(480,480,true,false);},"CAPTURE_DISCONTINUITY");
      rejects([]{Continuity e;e.packet(0,10,false,true);},"CAPTURE_TIMESTAMP_INVALID");checks++;}
    std::cout<<"{\"state\":\"PASS\",\"portableChecks\":"<<checks<<",\"hardwareValidated\":false}"<<std::endl;return 0;
  }catch(...){std::cout<<"{\"state\":\"FAILED\",\"code\":\"PORTABLE_CORE_TEST_FAILED\"}"<<std::endl;return 2;}
}

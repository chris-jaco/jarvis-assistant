// Deterministic virtual scheduler, real SPSC/assembler. Synthetic samples only.
#include "native-live-core.h"
#include "native-calibration-core.h"
#include <cassert>
using namespace atlas_live;
static void replay(int delay,int initial){
  Queue queue;atlas_cal::CapacityWait wait;Assembler assembler;
  std::vector<float> original(32*1600+11),fed;
  for(size_t i=0;i<original.size();i++){uint32_t bits=0x3e000000+static_cast<uint32_t>(i);if(i%37==0)bits=0x80000000;std::memcpy(&original[i],&bits,4);}
  // Occupancy is real, not a synthetic pending() stub. Initial blocks have the same order/data.
  for(int b=0;b<initial;b++){Block block;block.size=1600;block.sequence=b;std::memcpy(block.pcm.data(),original.data()+b*1600,6400);assert(queue.push(block));}
  double clock=0,consumerReady=delay;uint64_t next=0,high=initial,pushes=initial;
  const auto consume=[&]{if(clock<consumerReady)return;Block b;while(queue.pop(b)){assert(b.sequence==next++);fed.insert(fed.end(),b.pcm.begin(),b.pcm.begin()+b.size);b.wipe();}consumerReady=clock+10;};
  for(size_t at=initial*1600;at<original.size();at+=1600){
    // This test may start full; initial occupancy does not authorize skipping a gate.
    const size_t n=std::min<size_t>(1600,original.size()-at);
    clock=std::max(clock,(at-initial*1600+n)/16.0);consume();
    assert(wait.beforeBlock([&]{return queue.pending();},[]{return false;},[&]{return clock;},[&]{clock+=5;consume();},10000));
    // Use an assembler with exact next sequence for the remaining portion.
    for(size_t i=0;i<n;i++)assembler.accept(original[at+i],clock,[&](const Block &part){Block b=part;b.sequence+=initial;uint64_t occupied=0;pushes++;assert(queue.push(b,&occupied));high=std::max(high,occupied);return true;});
  }
  auto tail=assembler.tail();clock=10000;consume();
  if(tail.size){assert(tail.size==11);assert(tail.sequence+initial==next++);fed.insert(fed.end(),tail.pcm.begin(),tail.pcm.begin()+tail.size);tail.wipe();}
  assert(next==33&&pushes==32&&high<=4&&queue.pending()==0);
  assert(fed.size()==original.size()&&std::memcmp(fed.data(),original.data(),fed.size()*4)==0);
  queue.wipeAfterJoin();assert(queue.pending()==0);
}
int main(){
  for(int delay:{120,350,502,1000})for(int occupancy:{0,1,2,3,4})replay(delay,occupancy);
  for(bool cancel:{false,true}){
    atlas_cal::CapacityWait wait;double clock=0;bool stopped=false;
    try{const bool ok=wait.beforeBlock([]{return 4;},[&]{return stopped;},[&]{return clock;},[&]{clock+=5;if(cancel&&clock==15)stopped=true;},30);
      assert(cancel&&!ok&&clock==15);
    }catch(const atlas_cal::Error &e){assert(!cancel&&!std::strcmp(e.code,"CALIBRATION_REPLAY_TIMEOUT")&&clock==30);}
    assert(wait.count==1&&wait.totalMs==clock&&wait.maxMs==clock);
  }
  atlas_cal::CapacityWait broken;double clock=0;
  try{broken.beforeBlock([]{return 4;},[]{return false;},[&]{return clock;},[&]{clock=5;throw atlas_cal::Error{"CAPTURE_WAIT_FAILED"};},30);assert(false);}catch(const atlas_cal::Error&){assert(broken.count==1&&broken.totalMs==5);}
  // A rejected push is still a terminal assembler error. It is never retried by the gate.
  Assembler assembler;int attempts=0;
  try{for(int i=0;i<1600;i++)assembler.accept(.1f,0,[&](const Block&){attempts++;return false;});assert(false);}catch(const Error&e){assert(!std::strcmp(e.code,"AUDIO_OVERFLOW")&&attempts==1);}
  // Strict producer retains overflow with a stalled consumer (no capacity gate).
  Queue strict;Block b;b.size=1600;for(int i=0;i<4;i++)assert(strict.push(b));assert(!strict.push(b));strict.wipeAfterJoin();assert(strict.pending()==0);
}

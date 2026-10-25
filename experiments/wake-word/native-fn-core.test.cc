#include "native-fn-core.h"
#include <iostream>
#include <thread>
#include <stdexcept>
static void require(bool b){if(!b)throw std::runtime_error("FN_CORE_FAILED");}
int main(){try{
  atlas_fn::Signal s;for(int i=0;i<1600;i++)s.add(.01f);
  require(s.samples==1600&&std::abs(s.rms()-.01)<1e-7&&s.peak>.0099&&s.clipped==0&&s.nearZero==0);
  s.add(0);s.add(1);s.add(NAN);require(s.nearZero==1&&s.clipped==1&&s.invalid==1);
  // Simulate a permanently stalled writer. Every producer call still returns.
  atlas_fn::LogQueue q;for(int i=0;i<64;i++)require(q.push("ACK\n"));require(!q.push("OVERFLOW\n"));
  std::array<char,128> out{};for(int i=0;i<64;i++)require(q.pop(out));require(!q.pop(out));require(!q.drained());
  atlas_fn::LogQueue parallel;
  std::thread a([&]{for(int i=0;i<32;i++)require(parallel.push("A\n"));});
  std::thread b([&]{for(int i=0;i<32;i++)require(parallel.push("B\n"));});a.join();b.join();
  int n=0;while(parallel.pop(out))n++;require(n==64&&parallel.drained());
  const std::string nonce(32,'a');atlas_fn::Receiver receiver;
  require(receiver.accept("M "+nonce+" 1 B",nonce,10).id==1);
  require(receiver.accept("M "+nonce+" 2 E",nonce,20).kind=='E');
  bool rejected=false;try{receiver.accept("M "+nonce+" 2 E",nonce,21);}catch(const atlas_fn::Error&){rejected=true;}require(rejected);
  rejected=false;try{receiver.accept("M "+std::string(32,'b')+" 3 B",nonce,22);}catch(const atlas_fn::Error&){rejected=true;}require(rejected);
  std::cout<<"{\"state\":\"PASS\",\"captureWaits\":0,\"hardwareValidated\":false}"<<std::endl;return 0;
}catch(...){return 2;}}

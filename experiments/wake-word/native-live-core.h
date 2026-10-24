// Portable experimental DSP/transport. No Windows, SDK, files, network or audio logging.
#pragma once
#include <algorithm>
#include <array>
#include <atomic>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <numeric>
#include <vector>

namespace atlas_live {
struct Error { const char *code; };
constexpr size_t block_samples = 1600;
constexpr size_t queued_blocks = 4;  // Native only: plus one decoder block and one assembler.
struct Block {
  std::array<float, block_samples> pcm{};
  uint32_t size = 0;
  uint64_t sequence = 0;
  double captureEndWallMs = 0;
  void wipe() { pcm.fill(0); size = 0; }
};
// Exactly one producer and one consumer. No mutex or inference wait in push().
class Queue {
  std::array<Block, queued_blocks> slots_{};
  alignas(64) std::atomic<uint64_t> write_{0};
  alignas(64) std::atomic<uint64_t> read_{0};
 public:
  static_assert(std::atomic<uint64_t>::is_always_lock_free, "Lock-free x64 atomics required");
  bool push(const Block &block, uint64_t *occupancy = nullptr) {
    const auto w = write_.load(std::memory_order_relaxed), r = read_.load(std::memory_order_acquire);
    if (w - r == queued_blocks) return false;
    slots_[w % queued_blocks] = block;
    write_.store(w + 1, std::memory_order_release);
    if (occupancy) *occupancy = w + 1 - r;
    return true;
  }
  bool pop(Block &block) {
    const auto r = read_.load(std::memory_order_relaxed), w = write_.load(std::memory_order_acquire);
    if (r == w) return false;
    auto &slot = slots_[r % queued_blocks]; block = slot; slot.wipe();
    read_.store(r + 1, std::memory_order_release); return true;
  }
  uint64_t pending() const { return write_.load(std::memory_order_acquire) - read_.load(std::memory_order_acquire); }
  // Only call after joining producer and consumer. Counters retain aborted audio accounting.
  void wipeAfterJoin() { Block block;while(pop(block))block.wipe();for(auto &slot:slots_)slot.wipe(); }
  ~Queue() { for (auto &slot : slots_) slot.wipe(); }
};
enum class Kind { pcm16, pcm24, pcm32, float32, float64 };
struct Format { uint32_t rate, channels, bytes, validBits; Kind kind; };
inline bool supportedRate(uint32_t rate) {
  for (auto value : {16000u, 32000u, 44100u, 48000u, 88200u, 96000u, 176400u, 192000u}) if (value == rate) return true;
  return false;
}
inline void validate(const Format &f) {
  if (!supportedRate(f.rate) || f.channels < 1 || f.channels > 8) throw Error{"CAPTURE_FORMAT_UNSUPPORTED"};
  const unsigned bits = f.kind == Kind::pcm16 ? 16 : f.kind == Kind::pcm24 ? 24 : f.kind == Kind::float64 ? 64 : 32;
  if (f.bytes * 8 != bits || !f.validBits || f.validBits > bits
      || ((f.kind == Kind::float32 || f.kind == Kind::float64) && f.validBits != bits)) throw Error{"CAPTURE_FORMAT_UNSUPPORTED"};
}
inline float sample(const unsigned char *p, Kind kind) {
  float value = 0;
  if (kind == Kind::float32) std::memcpy(&value, p, 4);
  else if (kind == Kind::float64) { double v; std::memcpy(&v, p, 8); value = static_cast<float>(v); }
  else if (kind == Kind::pcm16) { int16_t v; std::memcpy(&v, p, 2); value = v / 32768.f; }
  else if (kind == Kind::pcm32) { int32_t v; std::memcpy(&v, p, 4); value = static_cast<float>(v / 2147483648.0); }
  else {
    uint32_t u = p[0] | uint32_t(p[1]) << 8 | uint32_t(p[2]) << 16;
    if (u & 0x800000) u |= 0xff000000;
    int32_t v; std::memcpy(&v, &u, 4); value = v / 8388608.f;
  }
  if (!std::isfinite(value) || std::abs(value) > 8) throw Error{"CAPTURE_SAMPLE_INVALID"};
  return value;
}
struct Signal {
  uint64_t samples = 0, clipped = 0, nearZero = 0;
  double squares = 0, peak = 0;
  void add(float value) { samples++; squares += double(value) * value;
    peak = std::max(peak, double(std::abs(value))); clipped += std::abs(value) >= .999f; nearZero += std::abs(value) < 1e-5f; }
  double rms() const { return samples ? std::sqrt(squares / samples) : 0; }
};

// Rational output clock, causal Blackman-windowed sinc polyphase FIR.
// Output count = floor(inputCount * 16000 / rate), independent of packet boundaries.
// No flush padding. 16 kHz bypasses filtering and preserves input bits exactly.
class Resampler {
  uint32_t rate_, gcd_, phases_, taps_, credit_ = 0;
  uint64_t received_ = 0, emitted_ = 0;
  std::vector<float> history_;
  std::vector<double> coefficients_;
 public:
  explicit Resampler(uint32_t rate) : rate_(rate), gcd_(std::gcd(rate, 16000u)), phases_(16000 / gcd_),
      taps_(rate == 16000 ? 1 : 128 * ((rate + 15999) / 16000) + 1) {
    if (!supportedRate(rate)) throw Error{"CAPTURE_FORMAT_UNSUPPORTED"};
    history_.resize(taps_); coefficients_.resize(size_t(phases_) * taps_);
    if (rate == 16000) { coefficients_[0] = 1; return; }
    constexpr double pi = 3.14159265358979323846;
    const double cutoff = 7200.0 / rate, delay = (taps_ - 1) / 2.0;
    for (uint32_t phase = 0; phase < phases_; phase++) {
      const double fraction = double(phase * gcd_) / 16000; double sum = 0;
      for (uint32_t j = 0; j < taps_; j++) {
        const double x = 2 * cutoff * (j - delay - fraction);
        const double sinc = std::abs(x) < 1e-14 ? 1 : std::sin(pi * x) / (pi * x);
        const double window = .42 - .5 * std::cos(2 * pi * j / (taps_ - 1)) + .08 * std::cos(4 * pi * j / (taps_ - 1));
        const double c = 2 * cutoff * sinc * window;
        coefficients_[size_t(phase) * taps_ + j] = c; sum += c;
      }
      for (uint32_t j = 0; j < taps_; j++) coefficients_[size_t(phase) * taps_ + j] /= sum;
    }
  }
  template<class Emit> void accept(float value, Emit emit) {
    if (!std::isfinite(value)) throw Error{"CAPTURE_SAMPLE_INVALID"};
    if(rate_==16000){received_++;emitted_++;emit(value);return;}
    const auto index = received_++;
    history_[index % taps_] = value; credit_ += 16000;
    if (credit_ < rate_) return;
    credit_ -= rate_;
    double output = 0; const size_t phase = credit_ / gcd_;
    for (uint32_t j = 0; j < taps_; j++) output += history_[(index + taps_ - j) % taps_] * coefficients_[phase * taps_ + j];
    emitted_++; emit(static_cast<float>(output));
  }
  uint64_t received() const { return received_; }
  uint64_t emitted() const { return emitted_; }
  uint32_t taps() const { return taps_; }
  double delayMs() const { return rate_ == 16000 ? 0 : 1000.0 * (taps_ - 1) / (2 * rate_); }
  ~Resampler() { std::fill(history_.begin(), history_.end(), 0); }
};

class Assembler {
  Block block_;
  uint64_t next_ = 0;
  bool failed_ = false;
 public:
  template<class Push> void accept(float sample, double captureEndWallMs, Push push) {
    if(failed_)throw Error{"ASSEMBLER_STOPPED"};
    block_.pcm[block_.size++] = sample; block_.captureEndWallMs = captureEndWallMs;
    if (block_.size == block_samples) {
      block_.sequence = next_;
      if (!push(block_)) {failed_=true;throw Error{"AUDIO_OVERFLOW"};}
      next_++; block_.wipe();
    }
  }
  Block tail() { block_.sequence = next_; return block_; }
  ~Assembler() { block_.wipe(); }
};
struct Continuity {
  uint64_t packets = 0, expected = 0, discontinuities = 0, initialDiscontinuities = 0;
  void packet(uint64_t position, uint32_t frames, bool discontinuity, bool timestampError) {
    if (timestampError) throw Error{"CAPTURE_TIMESTAMP_INVALID"};
    if (discontinuity) { if (!packets) initialDiscontinuities++; else { discontinuities++; throw Error{"CAPTURE_DISCONTINUITY"}; } }
    if (packets && position != expected) { discontinuities++; throw Error{"CAPTURE_DISCONTINUITY"}; }
    expected = position + frames; packets++;
  }
};
}  // namespace atlas_live

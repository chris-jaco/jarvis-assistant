import { mediaDevices, RTCPeerConnection } from 'react-native-webrtc';
import type { CallScope } from './session';
import { requireNativeModule } from 'expo';

interface AudioRoute {
  addListener(event: 'interruption', listener: () => void): { remove(): void };
  start(bluetooth: boolean): void;
  stop(): void;
}

export async function connect(scope: CallScope, pin: string, bluetooth: boolean) {
  const { signal } = scope;
  const tokenResponse = await fetch('http://127.0.0.1:8765/token', {
    method: 'POST', headers: { Authorization: 'Bearer ' + pin }, signal
  });
  if (!tokenResponse.ok) throw new Error('ISSUER_UNAVAILABLE');
  const { value } = await tokenResponse.json();
  if (typeof value !== 'string' || !value.startsWith('ek_') || signal.aborted) throw new Error('INVALID_SESSION');
  const route = requireNativeModule<AudioRoute>('AtlasAudioRoute');
  const subscription = route.addListener('interruption', scope.fail);
  scope.own(() => subscription.remove());
  route.start(bluetooth);
  scope.own(() => route.stop());
  const stream = await mediaDevices.getUserMedia({ audio: true, video: false });
  scope.own(() => { for (const track of stream.getTracks()) track.stop(); stream.release(); });
  if (signal.aborted) return;
  const pc = new RTCPeerConnection();
  scope.own(() => pc.close());
  const tracks = stream.getAudioTracks();
  if (tracks.length !== 1) throw new Error('MICROPHONE_UNAVAILABLE');
  tracks[0].addEventListener('ended', scope.fail);
  pc.addTrack(tracks[0], stream);
  const events = pc.createDataChannel('oai-events');
  scope.own(() => events.close());
  function ready() {
    if (events.readyState === 'open' && pc.connectionState === 'connected') scope.connected();
  }
  events.addEventListener('open', ready);
  events.addEventListener('close', scope.fail);
  events.addEventListener('error', scope.fail);
  events.addEventListener('message', event => {
    if (typeof event.data !== 'string') return;
    try { if (JSON.parse(event.data).type === 'error') scope.fail(); }
    catch { scope.fail(); }
  });
  pc.addEventListener('connectionstatechange', () => {
    if (signal.aborted) return;
    ready();
    if (['disconnected', 'failed', 'closed'].includes(pc.connectionState)) scope.fail();
  });
  const offer = await pc.createOffer();
  if (signal.aborted) return;
  await pc.setLocalDescription(offer);
  if (signal.aborted) return;
  const response = await fetch('https://api.openai.com/v1/realtime/calls', {
    method: 'POST', headers: { Authorization: 'Bearer ' + value, 'Content-Type': 'application/sdp' },
    body: offer.sdp, signal
  });
  if (!response.ok) throw new Error('NEGOTIATION_FAILED');
  const answer = await response.text();
  if (!signal.aborted) await pc.setRemoteDescription({ type: 'answer', sdp: answer });
}

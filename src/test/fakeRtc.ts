/** Test double for WebRTC (jsdom and Node have none). */
/** In-memory stand-in for RTCPeerConnection: offer/answer by SDP token, channels linked when the answer lands. */
export class FakeChannel {
  readyState: RTCDataChannelState = 'connecting';
  peer: FakeChannel | null = null;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  send(d: string) {
    this.peer?.onmessage?.({ data: d });
  }
  open() {
    this.readyState = 'open';
    this.onopen?.();
  }
}
let fakeSeq = 0;
const registry = new Map<string, FakePC>();
export class FakePC extends EventTarget {
  static failing = false;
  iceGatheringState = 'complete';
  connectionState = 'new';
  signalingState = 'stable';
  localDescription: { type: string; sdp: string } | null = null;
  ondatachannel: ((e: { channel: FakeChannel }) => void) | null = null;
  channel: FakeChannel | null = null;
  createDataChannel() {
    this.channel = new FakeChannel();
    return this.channel;
  }
  async createOffer() {
    return { type: 'offer', sdp: `offer-${++fakeSeq}` };
  }
  async createAnswer() {
    return { type: 'answer', sdp: `answer-${++fakeSeq}` };
  }
  async setLocalDescription(d: { type: string; sdp: string }) {
    this.localDescription = d;
    registry.set(d.sdp, this);
    if (d.type === 'offer') this.signalingState = 'have-local-offer';
  }
  async setRemoteDescription(d: { type: string; sdp: string }) {
    if (d.type !== 'answer' || FakePC.failing) return;
    const answerer = registry.get(d.sdp)!;
    const mine = this.channel!;
    const theirs = new FakeChannel();
    mine.peer = theirs;
    theirs.peer = mine;
    this.signalingState = 'stable';
    answerer.ondatachannel?.({ channel: theirs });
    theirs.open();
    mine.open();
    this.connectionState = answerer.connectionState = 'connected';
  }
  close() {
    this.connectionState = 'closed';
  }
}


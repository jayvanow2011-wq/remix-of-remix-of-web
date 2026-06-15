// Browser / Node example — how the Lovable frontend or a viewer connects.
// Mirrors the Socket.IO-style usage the user asked about, but uses native WS
// (which is what `ws` on the server expects).

const URL = 'wss://veltrix.hidenfree.com';
const KEY = 'replace-me-with-a-long-random-string';
const DEVICE = 'abc-123';

const socket = new WebSocket(`${URL}/?key=${encodeURIComponent(KEY)}`);

socket.addEventListener('open', () => {
  socket.send(JSON.stringify({ type: 'hello', role: 'viewer', deviceId: DEVICE }));
});

socket.addEventListener('message', e => {
  const msg = JSON.parse(e.data);
  console.log('←', msg);
});

// Send a WebRTC offer to the agent:
// socket.send(JSON.stringify({ type: 'offer', payload: { sdp, type: 'offer' } }));

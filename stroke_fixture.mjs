// Prints one valid stroke payload built with the app's own makePayload, so the e2e
// test registers exactly what the studio would send. Usage: node stroke_fixture.mjs
import { makePayload } from './src/timeline.js';

const pts = [
  {x:642, y:184, utc:'2026-10-24T12:00:00Z', selector:'button.btn', text:'Download',
   rect:{x:640, y:180, width:150, height:46}},
  {x:800, y:240, utc:'2026-10-24T12:00:01Z', selector:'h1', text:'The meeting intelligence platform you can trust.',
   rect:{x:0, y:0, width:800, height:60}}
];
const payload = makePayload(
  {id:'e2estroke1', tool:'pen', t:500, pts, elements:['button.btn','h1']},
  2500, {width:1200, height:800}, ''
);
console.log(JSON.stringify(payload));

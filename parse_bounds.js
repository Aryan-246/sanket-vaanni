const fs = require('fs');
const content = fs.readFileSync('C:/Users/arvis/.gemini/antigravity-ide/brain/2da45c41-ef82-4067-a90e-f03d86a6186e/dump.xml', 'utf8');
const regex = /text="([^"]*)"[^>]*bounds="(\[[0-9,]+\]\[[0-9,]+\])"/g;
let m;
while ((m = regex.exec(content))) {
  if (['Left', 'Right', 'Find', 'Disconnect', 'Connect both'].includes(m[1])) {
    console.log(m[1], m[2]);
  }
}

const fs = require('fs');
let content = fs.readFileSync('codegen-recorder.js', 'utf8');

const dupIndex = content.indexOf("hromium } = require('playwright');");
const resumeIndex = content.indexOf("      this.selectOptionMap = {};", dupIndex);

if (dupIndex !== -1 && resumeIndex !== -1) {
    content = content.substring(0, dupIndex) + content.substring(resumeIndex);
    fs.writeFileSync('codegen-recorder.js', content);
    console.log("Cleaned");
} else {
    console.log("Could not find boundaries", dupIndex, resumeIndex);
}

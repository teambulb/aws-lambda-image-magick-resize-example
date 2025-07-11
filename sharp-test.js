const fs = require('fs/promises');
const sharp = require('sharp');
const path = require('path');

(async () => {
    try {
        const input = await fs.readFile(path.resolve(__dirname, 'sample.heic'));

    // fallback for HEIC handled via libvips if needed
        const { data, info } = await sharp(input, { failOnError: false })
            .resize({ width: 200 })
      .toFormat('png') // safer format
            .toBuffer({ resolveWithObject: true });

    await fs.writeFile('output.png', data);
    console.log('✅ Converted image:', info);
    } catch (err) {
        console.error('❌ HEIC decode failed', err);
    }
})();

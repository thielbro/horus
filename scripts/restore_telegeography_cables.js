const fs = require('fs');
const https = require('https');

const url = "https://raw.githubusercontent.com/telegeography/www.submarinecablemap.com/master/web/public/api/v3/cable/cable-geo.json";
const outputFile = "public/data/submarine-cables.json";

const req = https.get(url, (res) => {
    let data = '';
    res.on('data', chunk => data += chunk);
    res.on('end', () => {
        let json;
        try {
            json = JSON.parse(data);
        } catch (err) {
            console.error('Error parsing cable JSON:', err);
            process.exitCode = 1;
            return;
        }
        json.features = json.features.map(f => {
            if (!f.properties.color) {
                f.properties.color = '#4FC3F7';
            }
            return f;
        });
        fs.writeFileSync(outputFile, JSON.stringify(json));
        console.log(`Successfully restored ${json.features.length} cables with original TeleGeography colors and properties!`);
    });
}).on('error', err => {
    console.error('Error fetching cables:', err);
    process.exitCode = 1;
});

req.setTimeout(30000, () => {
    req.destroy(new Error('Cable restore timed out'));
});

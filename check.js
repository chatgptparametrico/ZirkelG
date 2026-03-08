const fs = require('fs');
try {
    const html = fs.readFileSync('index.html', 'utf8');
    const start = html.indexOf('<script type="module">') + 22;
    const end = html.lastIndexOf('</script>');
    const script = html.substring(start, end);
    fs.writeFileSync('temp.js', script);
} catch (e) {
    console.error(e);
}

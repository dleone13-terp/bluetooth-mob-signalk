const pluginId = window.location.pathname.split('/')[1] || 'signalk-bluetooth-scanner'

setInterval(() => { fetchDevices(); fetchWatched() }, 2000)

async function fetchDevices() {
    try {
        const { devices } = await fetch(`/plugins/${pluginId}/devices`).then(r => r.json())
        
        if (!devices?.length) {
            document.getElementById('devices').innerHTML = '<p>No devices found</p>'
            return
        }

        const sorted = devices.sort((a, b) => new Date(a.firstSeen) - new Date(b.firstSeen))
        document.getElementById('devices').innerHTML = `
            <table border="1">
                <tr><th>Address</th><th>Name</th><th>Signal</th><th>First Seen</th><th>Last Seen</th><th>Action</th></tr>
                ${sorted.map(d => `
                    <tr>
                        <td>${d.address}</td>
                        <td>${d.name || 'Unknown'}</td>
                        <td><meter min="0" max="100" low="30" high="60" optimum="80" value="${Math.max(0, Math.min(100, d.rssi + 100))}"></meter></td>
                        <td>${new Date(d.firstSeen).toLocaleTimeString()}</td>
                        <td>${new Date(d.lastSeen).toLocaleTimeString()}</td>
                        <td><button onclick="watchDevice('${d.address}', '${d.name || 'Unknown'}')">Watch</button></td>
                    </tr>
                `).join('')}
            </table>
        `
    } catch (error) {
        console.error('Failed to fetch devices:', error)
    }
}

async function fetchWatched() {
    try {
        const { watched } = await fetch(`/plugins/${pluginId}/watched`).then(r => r.json())
        
        const html = watched?.length ? `
            <table border="1">
                <tr><th>Name</th><th>Address</th><th>Timeout</th><th>Action</th></tr>
                ${watched.map(w => `
                    <tr>
                        <td>${w.userName}</td>
                        <td>${w.address}</td>
                        <td>${w.timeoutSeconds}s</td>
                        <td><button onclick="unwatchDevice('${w.address}')">Unwatch</button></td>
                    </tr>
                `).join('')}
            </table>
        ` : '<p>No devices being watched</p>'
        
        document.getElementById('watched').innerHTML = html
    } catch (error) {
        console.error('Failed to fetch watched:', error)
    }
}

async function watchDevice(address, defaultName) {
    const userName = prompt('Enter name for this person:', defaultName)
    const timeout = userName && prompt('Enter timeout in seconds (e.g., 30):', '30')
    
    if (!userName || !timeout) return
    
    try {
        await fetch(`/plugins/${pluginId}/watch`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ address, userName, timeoutSeconds: parseInt(timeout) })
        })
        fetchWatched()
    } catch (err) {
        alert('Failed to set watch: ' + err)
    }
}

async function unwatchDevice(address) {
    if (!confirm('Stop watching this device?')) return
    
    try {
        await fetch(`/plugins/${pluginId}/watch/${encodeURIComponent(address)}`, { method: 'DELETE' })
        fetchWatched()
    } catch (err) {
        alert('Failed to unwatch: ' + err)
    }
}

fetchDevices()
fetchWatched()


// GLOBAL SYSTEM HISTORIES
const historyLimit = 30;
let cpuHistory = Array(historyLimit).fill(0);
let ramHistory = Array(historyLimit).fill(0);
let netHistory = Array(historyLimit).fill(0);

// FPS LATENCY HISTORY (60 points)
const fpsHistoryLimit = 60;
let fpsHistory = Array(fpsHistoryLimit).fill(16.7); // default 60fps frame time (16.7ms)

const circlePerimeter = 251.2; // 2 * PI * r = 2 * 3.14159 * 40

// POLLING STATE
const pollInterval = 1000;
let isCpuStressing = false;

// GPU WEBGL STATE
let canvas = null;
let gl = null;
let animationFrameId = null;
let shaderProgram = null;
let particleBuffer = null;
let isTesting = false;
let testStartTime = 0;
let lastFrameTime = 0;
let frameCount = 0;
let fpsTimer = 0;
let fpsList = [];
let currentFps = 60;

// TERMINAL STATE
let commandHistory = [];
let historyIndex = -1;

/* --- ON DOCUMENT READY --- */
document.addEventListener('DOMContentLoaded', () => {
    // 1. Tab Switching Logic
    const tabButtons = document.querySelectorAll('.tab-btn');
    const tabContents = document.querySelectorAll('.tab-content');
    
    tabButtons.forEach(btn => {
        btn.addEventListener('click', () => {
            const tabId = btn.getAttribute('data-tab');
            
            // Toggle active button
            tabButtons.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            
            // Toggle active content
            tabContents.forEach(content => {
                content.classList.remove('active');
                if (content.getAttribute('id') === tabId) {
                    content.classList.add('active');
                }
            });
            
            // Resize canvas if switching to benchmark tab
            if (tabId === 'tab-benchmarks') {
                setTimeout(resizeCanvas, 50);
            }
        });
    });

    // 2. CPU Stress Toggle Button
    const btnCpuStress = document.getElementById('btn-cpu-stress');
    btnCpuStress.addEventListener('click', toggleCpuStressTest);

    // 3. WebGL GPU Stress Toggle
    const btnStressWebGL = document.getElementById('btn-stress-webgl');
    btnStressWebGL.addEventListener('click', toggleWebGLStressTest);

    // 4. WebGL Particle Load Selector Buttons
    const optionBtns = document.querySelectorAll('.option-btn');
    optionBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            optionBtns.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            if (isTesting) {
                setupParticleBuffer(); // rebuild WebGL buffer with new size immediately
            }
        });
    });

    // 5. MangoHud Copy Button (benchmarks tab)
    const btnCopyMangoHudBench = document.getElementById('btn-copy-mangohud-bench');
    const copySuccessBench = document.getElementById('copy-success-bench');
    const mangohudCmdBench = document.getElementById('mangohud-cmd-bench');
    btnCopyMangoHudBench.addEventListener('click', () => {
        navigator.clipboard.writeText(mangohudCmdBench.innerText).then(() => {
            copySuccessBench.style.opacity = '1';
            setTimeout(() => { copySuccessBench.style.opacity = '0'; }, 2000);
        });
    });

    // 6. Terminal Event Listeners
    const btnTerminalSend = document.getElementById('btn-terminal-send');
    const terminalInput = document.getElementById('terminal-command-input');
    btnTerminalSend.addEventListener('click', sendTerminalCommand);
    terminalInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            sendTerminalCommand();
        }
    });

    // Terminal shortcut buttons
    const cmdShortcuts = document.querySelectorAll('.cmd-shortcut-btn');
    cmdShortcuts.forEach(btn => {
        btn.addEventListener('click', () => {
            const cmd = btn.getAttribute('data-cmd');
            terminalInput.value = cmd;
            sendTerminalCommand();
        });
    });

    // 7. Initialize Canvas and WebGL
    canvas = document.getElementById('gpu-canvas');
    resizeCanvas();
    window.addEventListener('resize', resizeCanvas);
    initWebGL();

    // 8. Start regular data poll
    fetchMetrics();
    setInterval(fetchMetrics, pollInterval);

    // Render initial graphs
    drawSvgGraph('cpu-graph-svg', cpuHistory, '#00f0ff');
    drawSvgGraph('ram-graph-svg', ramHistory, '#ff007f');
    drawSvgGraph('net-graph-svg', netHistory, '#ffb700');
    drawSvgGraph('fps-graph-svg', fpsHistory, '#39ff14', 100);
});

function resizeCanvas() {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = canvas.clientWidth * dpr;
    canvas.height = canvas.clientHeight * dpr;
    if (gl) {
        gl.viewport(0, 0, canvas.width, canvas.height);
    }
}

/* --- API METRICS SYNCING --- */
function fetchMetrics() {
    fetch('/api/metrics')
        .then(res => res.json())
        .then(data => {
            updateUI(data);
        })
        .catch(err => {
            console.error("Erro ao ler telemetria:", err);
            document.getElementById('system-status-badge').innerHTML = '<span class="pulse red"></span> ERRO';
            document.getElementById('system-status-badge').className = 'badge status-badge red';
        });
}

function updateUI(data) {
    // 1. Status Badge
    document.getElementById('system-status-badge').innerHTML = '<span class="pulse"></span> ESTÁVEL';
    document.getElementById('system-status-badge').className = 'badge status-badge green';

    // 2. General System specifications
    document.getElementById('dash-sys-os').innerText = data.system.os;
    document.getElementById('dash-sys-kernel').innerText = data.system.kernel;
    document.getElementById('dash-sys-res').innerText = data.system.resolution + " @ " + data.system.refresh_rate;
    document.getElementById('dash-sys-uptime').innerText = data.system.uptime;

    // 3. CPU Core and Thermal gauges
    const cpuVal = Math.round(data.cpu.usage);
    document.getElementById('cpu-percent').innerText = cpuVal;
    setCirclePercentage(document.getElementById('cpu-circle'), cpuVal);

    // CPU Model descriptions
    document.getElementById('dashboard-cpu-model').innerText = data.cpu.model.replace(/\(R\)|\(TM\)/gi, '').substring(0, 28) + '...';
    
    // CPU Temperatures
    const tempVal = data.cpu.temp;
    document.getElementById('cpu-temp-text').innerText = Math.round(tempVal);
    document.getElementById('header-cpu-temp').innerText = tempVal.toFixed(1) + "°C";
    
    // Dynamic thermal colors mapping: blue -> green -> yellow -> red
    let thermalColor = '#00f0ff'; // cold
    if (tempVal >= 75) {
        thermalColor = '#ff3b30'; // hot red
        document.getElementById('cpu-temp-badge').className = "badge temp-badge red-alert";
    } else if (tempVal >= 60) {
        thermalColor = '#ffb700'; // warm yellow
        document.getElementById('cpu-temp-badge').className = "badge temp-badge warning-alert";
    } else if (tempVal >= 45) {
        thermalColor = '#39ff14'; // cool green
        document.getElementById('cpu-temp-badge').className = "badge temp-badge";
    } else {
        document.getElementById('cpu-temp-badge').className = "badge temp-badge";
    }
    
    // Apply dynamic thermal color directly to circle stroke and gauge indicator
    const tempCircle = document.getElementById('temp-circle');
    tempCircle.style.stroke = thermalColor;
    tempCircle.style.filter = `drop-shadow(0 0 5px ${thermalColor}80)`;
    setCirclePercentage(tempCircle, Math.min(tempVal, 100));
    document.getElementById('temp-dot').style.backgroundColor = thermalColor;
    document.getElementById('temp-dot').style.boxShadow = `0 0 6px ${thermalColor}`;

    // Frequency readout
    const freqStr = data.gpu.freq_act + " MHz / " + data.gpu.freq_max + " MHz";
    document.getElementById('dash-gpu-freq').innerText = freqStr;
    document.getElementById('gpu-clock-val').innerText = data.gpu.freq_act + " MHz";

    // Historical CPU graph
    cpuHistory.push(cpuVal);
    cpuHistory.shift();
    drawSvgGraph('cpu-graph-svg', cpuHistory, '#00f0ff');

    // Update Core progress bars in stress panel
    updateCoresPanel(data.cpu.cores);

    // 4. Memory specs
    const ramVal = Math.round(data.ram.percent);
    document.getElementById('ram-percent').innerText = ramVal;
    setCirclePercentage(document.getElementById('ram-circle'), ramVal);
    
    const usedGB = (data.ram.used / (1024 ** 3)).toFixed(1);
    const totalGB = (data.ram.total / (1024 ** 3)).toFixed(1);
    const availGB = (data.ram.free / (1024 ** 3)).toFixed(1);
    
    document.getElementById('ram-specs-short').innerText = `${usedGB} GB / ${totalGB} GB`;
    document.getElementById('ram-used').innerText = usedGB + " GB";
    document.getElementById('ram-avail').innerText = availGB + " GB";
    document.getElementById('ram-total').innerText = totalGB + " GB";

    ramHistory.push(ramVal);
    ramHistory.shift();
    drawSvgGraph('ram-graph-svg', ramHistory, '#ff007f');

    // 5. Storage specs
    const diskTotal = (data.disk.total / (1024 ** 3)).toFixed(0);
    const diskUsed = (data.disk.used / (1024 ** 3)).toFixed(0);
    document.getElementById('storage-dashboard-text').innerText = `${diskUsed} GB / ${diskTotal} GB (${Math.round(data.disk.percent)}%)`;
    document.getElementById('storage-dashboard-fill').style.width = data.disk.percent + "%";

    // 6. Active Top Processes (with custom app icons based on name matches)
    updateTopProcesses(data.top_processes);

    // 7. Network diagnostics and metrics
    document.getElementById('net-ip-address').innerText = "IP LOCAL: " + data.network.local_ip;
    document.getElementById('net-ping-val').innerText = data.network.ping.toFixed(1) + " ms";
    document.getElementById('net-jitter-val').innerText = data.network.jitter.toFixed(1) + " ms";
    document.getElementById('net-loss-val').innerText = data.network.packet_loss.toFixed(1) + "%";
    document.getElementById('net-wifi-val').innerText = data.network.wifi_signal + "%";
    
    // Download and upload speed readouts
    const downKB = data.network.down / 1024;
    const upKB = data.network.up / 1024;
    document.getElementById('dashboard-net-down').innerText = downKB > 1024 ? (downKB / 1024).toFixed(1) + " MB/s" : downKB.toFixed(1) + " KB/s";
    document.getElementById('dashboard-net-up').innerText = upKB > 1024 ? (upKB / 1024).toFixed(1) + " MB/s" : upKB.toFixed(1) + " KB/s";

    // Network history graph
    const netScaled = Math.min((downKB / 1024) * 10, 100); // map 10MB/s to 100 max scale
    netHistory.push(netScaled);
    netHistory.shift();
    drawSvgGraph('net-graph-svg', netHistory, '#ffb700');

    // 8. Battery widget status logic
    const batCard = document.getElementById('battery-monitoring-card');
    if (data.battery) {
        batCard.style.display = 'block';
        document.getElementById('battery-percent-text').innerText = data.battery.percent + "%";
        let statText = "Descarregando";
        let statusLower = (data.battery.status || "Unknown").toLowerCase();
        if (statusLower === "charging") {
            statText = "Carregando";
        } else if (statusLower === "full") {
            statText = "Totalmente Carregada (Full)";
        } else if (statusLower === "discharging") {
            statText = "Em Bateria (Discharging)";
        } else if (statusLower === "not charging") {
            statText = "Não Carregando (AC Conectado)";
        } else {
            statText = data.battery.status || "Desconhecido";
        }
        document.getElementById('battery-plugged-state').innerText = statText;
        document.getElementById('battery-watt-val').innerText = data.battery.watts + " W";
        document.getElementById('battery-cycles-val').innerText = data.battery.cycles;
        document.getElementById('battery-health-val').innerText = data.battery.health + "%";
        document.getElementById('battery-power-mode').innerText = data.battery.power_mode;

        // remaining time calculations
        if (statusLower === "charging" && data.battery.secsleft > 0) {
            const h = Math.floor(data.battery.secsleft / 3600);
            const m = Math.floor((data.battery.secsleft % 3600) / 60);
            document.getElementById('battery-time-val').innerText = `${h}h ${m}m até completar`;
        } else if (statusLower === "discharging" && data.battery.secsleft > 0) {
            const h = Math.floor(data.battery.secsleft / 3600);
            const m = Math.floor((data.battery.secsleft % 3600) / 60);
            document.getElementById('battery-time-val').innerText = `${h}h ${m}m restantes`;
        } else if (statusLower === "full") {
            document.getElementById('battery-time-val').innerText = "Carregada";
        } else if (statusLower === "charging") {
            document.getElementById('battery-time-val').innerText = "Carregando...";
        } else {
            document.getElementById('battery-time-val').innerText = "Alimentado por AC";
        }
    } else {
        batCard.style.display = 'none';
    }

    // 9. CPU Stress status indicators
    isCpuStressing = data.cpu.stress_active;
    const btnCpu = document.getElementById('btn-cpu-stress');
    if (isCpuStressing) {
        btnCpu.classList.add('active');
        btnCpu.querySelector('.btn-text').innerText = "PARAR TESTE DA CPU";
    } else {
        btnCpu.classList.remove('active');
        btnCpu.querySelector('.btn-text').innerText = "INICIAR TESTE DA CPU";
    }

    // Thermal throttling indicators
    const throttleInd = document.getElementById('throttling-indicator');
    if (data.cpu.throttling) {
        throttleInd.className = "throttling-status throttled";
        throttleInd.querySelector('.status-text').innerText = "THROTTLING TÉRMICO ATIVO (ALTA TEMP!)";
    } else {
        throttleInd.className = "throttling-status";
        throttleInd.querySelector('.status-text').innerText = "ESTÁVEL (SEM THROTTLING)";
    }

    // 10. Gaming Runtimes Status
    document.getElementById('game-status-proton').innerText = data.gaming.proton;
    document.getElementById('game-status-vulkan').innerText = data.gaming.vulkan;
    document.getElementById('game-status-mangohud').innerText = data.gaming.mangohud;
    document.getElementById('game-status-gamemode').innerText = data.gaming.gamemode;
    document.getElementById('game-status-dxvk').innerText = data.gaming.dxvk;
}

function setCirclePercentage(circle, percent) {
    const offset = circlePerimeter - (percent / 100) * circlePerimeter;
    circle.style.strokeDashoffset = offset;
}

/* --- RENDER CORES PROGRESS GRID --- */
function updateCoresPanel(cores) {
    const grid = document.getElementById('cores-grid-bench');
    grid.innerHTML = '';
    cores.forEach((coreVal, idx) => {
        const valRounded = Math.round(coreVal);
        const coreBox = document.createElement('div');
        coreBox.className = 'core-box';
        coreBox.innerHTML = `
            <div class="core-info">
                <span class="core-name">Núcleo ${idx}</span>
                <span class="core-value">${valRounded}%</span>
            </div>
            <div class="core-bar-bg">
                <div class="core-bar-fill" style="width: ${valRounded}%"></div>
            </div>
        `;
        grid.appendChild(coreBox);
    });
}

/* --- PROCESS LIST RENDERING WITH APPLICATION ICONS --- */
function updateTopProcesses(processes) {
    const container = document.getElementById('process-list-container');
    container.innerHTML = '';
    
    if (processes.length === 0) {
        container.innerHTML = '<div class="process-loading">Nenhum processo pesado ativo.</div>';
        return;
    }
    
    processes.forEach(proc => {
        // Find best visual icon match for system processes
        let icon = "⚙️"; // default generic settings wheel
        const nameLower = proc.name.toLowerCase();
        
        if (nameLower.includes('brave') || nameLower.includes('chrome') || nameLower.includes('firefox') || nameLower.includes('browser') || nameLower.includes('web')) {
            icon = "🌐"; // Browser globe
        } else if (nameLower.includes('steam') || nameLower.includes('game') || nameLower.includes('heroic') || nameLower.includes('lutris')) {
            icon = "🎮"; // game controller
        } else if (nameLower.includes('discord') || nameLower.includes('slack') || nameLower.includes('telegram') || nameLower.includes('chat')) {
            icon = "💬"; // comment chat bubble
        } else if (nameLower.includes('python') || nameLower.includes('app.py')) {
            icon = "🐍"; // python snake
        } else if (nameLower.includes('bash') || nameLower.includes('sh') || nameLower.includes('terminal') || nameLower.includes('konsole')) {
            icon = "💻"; // terminal screen
        } else if (nameLower.includes('code') || nameLower.includes('sublime') || nameLower.includes('intellij') || nameLower.includes('neovim')) {
            icon = "📝"; // code editor document
        } else if (nameLower.includes('spotify') || nameLower.includes('vlc') || nameLower.includes('music') || nameLower.includes('mpv')) {
            icon = "🎵"; // music note
        }
        
        let memStr = "";
        if (proc.mem >= 1024) {
            memStr = (proc.mem / 1024).toFixed(1) + " GB";
        } else {
            memStr = proc.mem.toFixed(0) + " MB";
        }

        const row = document.createElement('div');
        row.className = 'process-row';
        row.innerHTML = `
            <div class="process-icon">${icon}</div>
            <div class="process-name">${proc.name}</div>
            <div class="process-mem">${memStr}</div>
            <div class="process-cpu">${proc.cpu.toFixed(1)}%</div>
        `;
        container.appendChild(row);
    });
}

/* --- SVG BEZIER CURVE GENERATOR --- */
function drawSvgGraph(svgId, dataPoints, strokeColor, maxVal = 100) {
    const svg = document.getElementById(svgId);
    if (!svg) return;

    const width = svgId === 'fps-graph-svg' ? 600 : 300;
    const height = svgId === 'fps-graph-svg' ? 80 : 65;
    const padding = 2;
    
    const xStep = width / (dataPoints.length - 1);
    
    let points = [];
    for (let i = 0; i < dataPoints.length; i++) {
        const x = i * xStep;
        const val = Math.min(dataPoints[i], maxVal);
        const y = height - padding - (val / maxVal) * (height - padding * 2);
        points.push({ x, y });
    }
    
    let d = `M ${points[0].x} ${points[0].y}`;
    for (let i = 1; i < points.length; i++) {
        const cpX1 = points[i-1].x + xStep / 2;
        const cpY1 = points[i-1].y;
        const cpX2 = points[i].x - xStep / 2;
        const cpY2 = points[i].y;
        d += ` C ${cpX1} ${cpY1}, ${cpX2} ${cpY2}, ${points[i].x} ${points[i].y}`;
    }
    
    const areaD = `${d} L ${width} ${height} L 0 ${height} Z`;
    
    const linePath = svg.querySelector('.graph-line');
    const areaPath = svg.querySelector('.graph-area');
    
    if (linePath) linePath.setAttribute('d', d);
    if (areaPath) areaPath.setAttribute('d', areaD);
}

/* --- API CPU STRESS TRIGGER CONTROLS --- */
function toggleCpuStressTest() {
    const targetState = !isCpuStressing;
    
    fetch('/api/stress/cpu', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ active: targetState })
    })
    .then(res => res.json())
    .then(data => {
        if (data.status === 'success') {
            isCpuStressing = data.cpu_stress_active;
            const btn = document.getElementById('btn-cpu-stress');
            if (isCpuStressing) {
                btn.classList.add('active');
                btn.querySelector('.btn-text').innerText = "PARAR TESTE DA CPU";
            } else {
                btn.classList.remove('active');
                btn.querySelector('.btn-text').innerText = "INICIAR TESTE DA CPU";
            }
        }
    })
    .catch(err => console.error("Erro ao alterar teste de estresse da CPU:", err));
}

/* --- INTERACTIVE 3D WEBGL PARTICLE SYSTEM SHADER BENCHMARK --- */
function initWebGL() {
    gl = canvas.getContext('webgl', { antialias: true, depth: false });
    if (!gl) {
        console.error("WebGL 1.0 não pôde ser carregado.");
        return;
    }

    const vsSource = `
        attribute float a_index;
        uniform float u_time;
        uniform float u_count;
        uniform int u_mode;
        varying vec4 v_color;

        float hash(float n) {
            return fract(sin(n) * 43758.5453123);
        }

        void main() {
            float idx = a_index;
            float total = u_count;
            
            float x = 0.0;
            float y = 0.0;
            float z = 0.0;
            vec3 col = vec3(1.0);
            
            if (u_mode == 0) { // Vortex
                float t = u_time * 0.45;
                float angle = idx * 0.004 + t * (1.1 + hash(idx) * 0.45);
                float radius = fract(idx * 0.00019) * 1.85;
                
                x = cos(angle) * radius;
                y = sin(angle) * radius;
                z = sin(idx * 0.009 + t) * 0.35 * (1.85 - radius);
                
                col = vec3(0.0, 0.94, 1.0) * (1.0 - radius * 0.35) + vec3(1.0, 0.0, 0.5) * (radius * 0.6);
            } else if (u_mode == 1) { // Quantum Plasma
                float t = u_time * 0.65;
                float u = fract(idx * 0.00025) * 3.14159 * 2.0;
                float v = fract(idx * 0.00059) * 3.14159;
                
                float r = 0.95 + 0.25 * sin(5.0 * u + t) * cos(6.0 * v + t);
                x = r * cos(u) * sin(v);
                y = r * sin(u) * sin(v);
                z = r * cos(v);
                
                col = vec3(1.0, 0.72, 0.0) * (0.5 + 0.5 * sin(x + t)) + vec3(0.2, 1.0, 0.0) * (0.5 + 0.5 * cos(y + t));
            } else { // Chaos
                float t = u_time * 1.3;
                float seed = idx * 13.0;
                float rx = hash(seed) - 0.5;
                float ry = hash(seed + 1.2) - 0.5;
                float rz = hash(seed + 2.4) - 0.5;
                
                float speed = 0.25 + hash(seed) * 0.75;
                float angle = t * speed + seed;
                
                x = sin(angle) * rx * 2.5;
                y = cos(angle) * ry * 2.5;
                z = sin(angle * 1.5) * rz * 2.5;
                
                col = vec3(1.0, 0.25, 0.0) * (0.5 + 0.5 * sin(t)) + vec3(0.55, 0.0, 1.0) * (0.5 + 0.5 * cos(t));
            }
            
            float distance = 3.6 - z;
            x = x / distance;
            y = y / distance;
            
            gl_Position = vec4(x, y, 0.0, 1.0);
            gl_PointSize = (1.6 + hash(idx) * 2.8) * (1.9 / distance);
            v_color = vec4(col, 0.9 / distance);
        }
    `;

    const fsSource = `
        precision mediump float;
        varying vec4 v_color;

        void main() {
            float d = distance(gl_PointCoord, vec2(0.5));
            if (d > 0.5) discard;
            float alpha = smoothstep(0.5, 0.1, d);
            gl_FragColor = vec4(v_color.rgb, v_color.a * alpha);
        }
    `;

    const vs = gl.createShader(gl.VERTEX_SHADER);
    gl.shaderSource(vs, vsSource);
    gl.compileShader(vs);
    if (!gl.getShaderParameter(vs, gl.COMPILE_STATUS)) {
        console.error("VS compilation error:", gl.getShaderInfoLog(vs));
    }

    const fs = gl.createShader(gl.FRAGMENT_SHADER);
    gl.shaderSource(fs, fsSource);
    gl.compileShader(fs);
    if (!gl.getShaderParameter(fs, gl.COMPILE_STATUS)) {
        console.error("FS compilation error:", gl.getShaderInfoLog(fs));
    }

    shaderProgram = gl.createProgram();
    gl.attachShader(shaderProgram, vs);
    gl.attachShader(shaderProgram, fs);
    gl.linkProgram(shaderProgram);
    
    if (!gl.getProgramParameter(shaderProgram, gl.LINK_STATUS)) {
        console.error("Shader link error:", gl.getProgramInfoLog(shaderProgram));
    }

    gl.useProgram(shaderProgram);
}

function setupParticleBuffer() {
    const activeOption = document.querySelector('.option-btn.active');
    const particleCount = activeOption ? parseInt(activeOption.getAttribute('data-particles')) : 25000;
    
    const indices = new Float32Array(particleCount);
    for (let i = 0; i < particleCount; i++) {
        indices[i] = i;
    }

    if (particleBuffer) {
        gl.deleteBuffer(particleBuffer);
    }
    
    particleBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, particleBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, indices, gl.STATIC_DRAW);
}

function toggleWebGLStressTest() {
    if (isTesting) {
        isTesting = false;
        if (animationFrameId) {
            cancelAnimationFrame(animationFrameId);
            animationFrameId = null;
        }
        document.getElementById('render-overlay').classList.remove('hidden');
        document.getElementById('btn-stress-webgl').innerText = "INICIAR TESTE";
        
        // Reset indicator badges
        document.getElementById('fps-counter-badge').innerText = "60 FPS";
        document.getElementById('frame-time-val').innerText = "16.7 ms";
        document.getElementById('fps-low-val').innerText = "0 FPS";
    } else {
        isTesting = true;
        document.getElementById('render-overlay').classList.add('hidden');
        document.getElementById('btn-stress-webgl').innerText = "PARAR TESTE";
        
        setupParticleBuffer();
        
        testStartTime = performance.now();
        lastFrameTime = performance.now();
        frameCount = 0;
        fpsTimer = performance.now();
        fpsList = [];
        fpsHistory = Array(fpsHistoryLimit).fill(16.7);
        
        animationFrameId = requestAnimationFrame(webglRenderLoop);
    }
}

function webglRenderLoop(now) {
    if (!isTesting) return;

    const dt = now - lastFrameTime;
    lastFrameTime = now;
    
    frameCount++;
    const currentFrameFps = 1000 / dt;
    fpsList.push(currentFrameFps);
    
    fpsHistory.push(dt);
    fpsHistory.shift();
    drawSvgGraph('fps-graph-svg', fpsHistory, '#39ff14', 120);

    if (now - fpsTimer >= 500) {
        const avgFps = frameCount / ((now - fpsTimer) / 1000);
        currentFps = Math.round(avgFps);
        
        // 1% Low FPS statistics sorting
        fpsList.sort((a, b) => a - b);
        const lowIndex = Math.max(0, Math.floor(fpsList.length * 0.01));
        const onePercentLow = Math.round(fpsList[lowIndex] || currentFps);
        
        document.getElementById('fps-counter-badge').innerText = currentFps + " FPS";
        document.getElementById('frame-time-val').innerText = dt.toFixed(1) + " ms";
        document.getElementById('fps-low-val').innerText = onePercentLow + " FPS";
        
        frameCount = 0;
        fpsTimer = now;
        fpsList = [];
    }

    // DRAW SHADERS FRAME
    gl.clearColor(0.02, 0.03, 0.06, 1.0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    gl.useProgram(shaderProgram);

    const aIndex = gl.getAttribLocation(shaderProgram, 'a_index');
    gl.enableVertexAttribArray(aIndex);
    gl.bindBuffer(gl.ARRAY_BUFFER, particleBuffer);
    gl.vertexAttribPointer(aIndex, 1, gl.FLOAT, false, 0, 0);

    const uTime = gl.getUniformLocation(shaderProgram, 'u_time');
    const uCount = gl.getUniformLocation(shaderProgram, 'u_count');
    const uMode = gl.getUniformLocation(shaderProgram, 'u_mode');

    const totalSeconds = (now - testStartTime) / 1000;
    
    const activeOption = document.querySelector('.option-btn.active');
    const particleCount = activeOption ? parseInt(activeOption.getAttribute('data-particles')) : 25000;
    
    const renderModeVal = document.getElementById('render-mode-select').value;
    let modeInt = 0; // vortex
    if (renderModeVal === 'plasma') modeInt = 1;
    if (renderModeVal === 'chaos') modeInt = 2;

    gl.uniform1f(uTime, totalSeconds);
    gl.uniform1f(uCount, particleCount);
    gl.uniform1i(uMode, modeInt);

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
    
    gl.drawArrays(gl.POINTS, 0, particleCount);

    gl.disable(gl.BLEND);

    animationFrameId = requestAnimationFrame(webglRenderLoop);
}

/* --- CYBER EMBEDDED MINI TERMINAL --- */
function sendTerminalCommand() {
    const input = document.getElementById('terminal-command-input');
    const cmd = input.value.trim();
    if (!cmd) return;

    const consoleOutput = document.getElementById('terminal-console-output');

    // Echo current command lines
    const echoLine = document.createElement('div');
    echoLine.className = 'terminal-line command-echo';
    echoLine.innerText = `ricardo@mint:~$ ${cmd}`;
    consoleOutput.appendChild(echoLine);
    
    // Clear input
    input.value = '';
    consoleOutput.scrollTop = consoleOutput.scrollHeight;

    // Send command POST request to backend API
    fetch('/api/terminal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command: cmd })
    })
    .then(res => res.json())
    .then(data => {
        // Output stdout if present
        if (data.stdout && data.stdout.trim() !== '') {
            const outLine = document.createElement('div');
            outLine.className = 'terminal-line output-stdout';
            outLine.innerText = data.stdout;
            consoleOutput.appendChild(outLine);
        }
        
        // Output stderr if present
        if (data.stderr && data.stderr.trim() !== '') {
            const errLine = document.createElement('div');
            errLine.className = 'terminal-line output-stderr';
            errLine.innerText = data.stderr;
            consoleOutput.appendChild(errLine);
        }

        // Output command complete code if non-zero
        if (data.exit_code !== 0) {
            const exitLine = document.createElement('div');
            exitLine.className = 'terminal-line system-msg';
            exitLine.innerText = `Processo encerrou com código de saída ${data.exit_code}`;
            consoleOutput.appendChild(exitLine);
        }
        
        consoleOutput.scrollTop = consoleOutput.scrollHeight;
    })
    .catch(err => {
        const errLine = document.createElement('div');
        errLine.className = 'terminal-line output-stderr';
        errLine.innerText = `Erro de conexão: ${err.message}`;
        consoleOutput.appendChild(errLine);
        consoleOutput.scrollTop = consoleOutput.scrollHeight;
    });
}

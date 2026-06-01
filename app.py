#!/usr/bin/env python3
import os
import sys
import json
import time
import socket
import threading
import platform
import subprocess
import shutil
import http.server
from http.server import SimpleHTTPRequestHandler
import psutil

# Check for GTK4 and WebKit6 in the python system path
import gi
gi.require_version('Gtk', '4.0')
gi.require_version('WebKit', '6.0')
from gi.repository import Gtk, WebKit, GLib

# Global network speed variables
last_net_bytes_sent = 0
last_net_bytes_recv = 0
last_net_time = 0

# Ping/latency global statistics
ping_ms = 0.0
ping_jitter = 0.0
ping_loss = 0.0
recent_pings = []

# CPU stress testing variables
cpu_stress_active = False
cpu_stress_threads = []

def ping_worker():
    global ping_ms, ping_jitter, ping_loss, recent_pings
    # Ping 1.1.1.1 every 3 seconds to measure ping and jitter
    while True:
        try:
            res = subprocess.run(["ping", "-c", "1", "-W", "1", "1.1.1.1"], capture_output=True, text=True)
            if res.returncode == 0:
                out = res.stdout
                if "time=" in out:
                    t_str = out.split("time=")[1].split()[0]
                    ms = float(t_str)
                    ping_ms = ms
                    
                    # Calculate Jitter
                    if recent_pings:
                        diffs = [abs(recent_pings[i] - recent_pings[i-1]) for i in range(1, len(recent_pings))]
                        diffs.append(abs(ms - recent_pings[-1]))
                        ping_jitter = sum(diffs) / len(diffs)
                        
                    recent_pings.append(ms)
                    if len(recent_pings) > 10:
                        recent_pings.pop(0)
                    
                    # Smooth down packet loss on success
                    ping_loss = max(0.0, ping_loss * 0.8)
            else:
                ping_loss = min(100.0, ping_loss * 0.8 + 20.0)
                ping_ms = 0.0
        except Exception:
            pass
        time.sleep(3.0)

def cpu_stress_worker():
    global cpu_stress_active
    while cpu_stress_active:
        # Trivial heavy arithmetic calculation to max out core
        _ = 98765.43 * 12345.67

def toggle_cpu_stress(active):
    global cpu_stress_active, cpu_stress_threads
    if active and not cpu_stress_active:
        cpu_stress_active = True
        cores = psutil.cpu_count(logical=True) or 2
        cpu_stress_threads = []
        for _ in range(cores):
            t = threading.Thread(target=cpu_stress_worker, daemon=True)
            t.start()
            cpu_stress_threads.append(t)
    elif not active and cpu_stress_active:
        cpu_stress_active = False
        cpu_stress_threads = []

def get_network_speeds():
    global last_net_bytes_sent, last_net_bytes_recv, last_net_time
    try:
        counters = psutil.net_io_counters()
        sent = counters.bytes_sent
        recv = counters.bytes_recv
        now = time.time()
        
        if last_net_time == 0:
            last_net_bytes_sent = sent
            last_net_bytes_recv = recv
            last_net_time = now
            return 0.0, 0.0
            
        dt = now - last_net_time
        if dt <= 0:
            return 0.0, 0.0
            
        up_speed = (sent - last_net_bytes_sent) / dt
        down_speed = (recv - last_net_bytes_recv) / dt
        
        last_net_bytes_sent = sent
        last_net_bytes_recv = recv
        last_net_time = now
        
        return up_speed, down_speed
    except Exception:
        return 0.0, 0.0

def get_gpu_freq():
    try:
        paths = [
            "/sys/class/drm/card1/device/drm/card1/gt_act_freq_mhz",
            "/sys/class/drm/card1/device/drm/card1/gt/gt0/rps_act_freq_mhz",
            "/sys/class/drm/card0/device/drm/card0/gt_act_freq_mhz",
            "/sys/class/drm/card0/device/drm/card0/gt/gt0/rps_act_freq_mhz"
        ]
        max_paths = [
            "/sys/class/drm/card1/device/drm/card1/gt_max_freq_mhz",
            "/sys/class/drm/card1/device/drm/card1/gt/gt0/rps_max_freq_mhz",
            "/sys/class/drm/card0/device/drm/card0/gt_max_freq_mhz",
            "/sys/class/drm/card0/device/drm/card0/gt/gt0/rps_max_freq_mhz"
        ]
        
        act_freq = 0
        for p in paths:
            if os.path.exists(p):
                with open(p, 'r') as f:
                    act_freq = int(f.read().strip())
                    break
        
        max_freq = 1
        for p in max_paths:
            if os.path.exists(p):
                with open(p, 'r') as f:
                    max_freq = int(f.read().strip())
                    break
                    
        return act_freq, max_freq
    except Exception:
        return 0, 1

def get_cpu_model():
    try:
        with open("/proc/cpuinfo", "r") as f:
            for line in f:
                if "model name" in line:
                    return line.split(":", 1)[1].strip()
    except Exception:
        pass
    return "Intel(R) Core(TM) Processor"

def get_uptime():
    try:
        with open('/proc/uptime', 'r') as f:
            uptime_seconds = float(f.readline().split()[0])
            hours = int(uptime_seconds // 3600)
            minutes = int((uptime_seconds % 3600) // 60)
            seconds = int(uptime_seconds % 60)
            if hours > 0:
                return f"{hours}h {minutes}m"
            else:
                return f"{minutes}m {seconds}s"
    except Exception:
        return "Unknown"

def get_display_info():
    try:
        res = subprocess.run(["xrandr"], capture_output=True, text=True, check=True)
        lines = res.stdout.splitlines()
        resolution = "Unknown"
        refresh_rate = "Unknown"
        
        for line in lines:
            if "*" in line:
                parts = line.strip().split()
                if len(parts) >= 2:
                    resolution = parts[0]
                    for p in parts[1:]:
                        if "*" in p:
                            refresh_rate = p.replace("*", "").replace("+", "") + " Hz"
                            break
                    break
        return resolution, refresh_rate
    except Exception:
        return "1920x1080", "60.00 Hz"

def get_os_version():
    try:
        os_info = {}
        with open('/etc/os-release', 'r') as f:
            for line in f:
                if '=' in line:
                    k, v = line.strip().split('=', 1)
                    os_info[k] = v.strip('"')
        return os_info.get("PRETTY_NAME", "Linux Mint")
    except Exception:
        return "Linux Mint"

# Temperature smoothing variables
cpu_temp_smoothed = 0.0
gpu_temp_smoothed = 0.0

def get_raw_temperatures():
    cpu_temp = 0.0
    gpu_temp = 0.0
    
    try:
        temps = psutil.sensors_temperatures()
        
        # 1. CPU Package Temperature
        if 'coretemp' in temps:
            for entry in temps['coretemp']:
                if 'package' in entry.label.lower() or entry.label == '':
                    cpu_temp = entry.current
                    break
            if cpu_temp == 0.0 and temps['coretemp']:
                cpu_temp = temps['coretemp'][0].current
        elif 'k10temp' in temps:
            for entry in temps['k10temp']:
                if 'tctl' in entry.label.lower():
                    cpu_temp = entry.current
                    break
            if cpu_temp == 0.0 and temps['k10temp']:
                cpu_temp = temps['k10temp'][0].current
        else:
            for name, entries in temps.items():
                if name not in ['i915', 'amdgpu', 'nouveau'] and entries:
                    cpu_temp = entries[0].current
                    break
                    
        # 2. GPU Temperature
        if 'i915' in temps and temps['i915']:
            gpu_temp = temps['i915'][0].current
        elif 'amdgpu' in temps and temps['amdgpu']:
            gpu_temp = temps['amdgpu'][0].current
        elif 'nouveau' in temps and temps['nouveau']:
            gpu_temp = temps['nouveau'][0].current
        else:
            pch_temp = 0.0
            for name, entries in temps.items():
                if 'pch' in name.lower() and entries:
                    pch_temp = entries[0].current
                    break
            if pch_temp > 0.0:
                gpu_temp = pch_temp
            else:
                gpu_temp = cpu_temp
    except Exception:
        pass
        
    return cpu_temp, gpu_temp

def get_smoothed_cpu_temp():
    global cpu_temp_smoothed
    raw_cpu, _ = get_raw_temperatures()
    if raw_cpu <= 0.0:
        return cpu_temp_smoothed
    if cpu_temp_smoothed == 0.0:
        cpu_temp_smoothed = raw_cpu
    else:
        # EMA alpha = 0.2 (gradual changes, highly stable)
        cpu_temp_smoothed = (raw_cpu * 0.2) + (cpu_temp_smoothed * 0.8)
    return cpu_temp_smoothed

def get_smoothed_gpu_temp():
    global gpu_temp_smoothed
    _, raw_gpu = get_raw_temperatures()
    if raw_gpu <= 0.0:
        return gpu_temp_smoothed
    if gpu_temp_smoothed == 0.0:
        gpu_temp_smoothed = raw_gpu
    else:
        # EMA alpha = 0.2 (gradual changes, highly stable)
        gpu_temp_smoothed = (raw_gpu * 0.2) + (gpu_temp_smoothed * 0.8)
    return gpu_temp_smoothed

def get_thermal_throttling():
    # If clock speeds are lowered compared to scaling_max_freq, it indicates potential throttling.
    try:
        throttled = False
        freq_dir = "/sys/devices/system/cpu/cpu0/cpufreq"
        if os.path.exists(freq_dir):
            with open(os.path.join(freq_dir, "scaling_cur_freq"), "r") as f:
                cur = int(f.read().strip())
            with open(os.path.join(freq_dir, "scaling_max_freq"), "r") as f:
                max_f = int(f.read().strip())
            # If current frequency runs significantly lower while CPU stress is active
            if cpu_stress_active and cur < (max_f * 0.85):
                throttled = True
        return throttled
    except Exception:
        return False

def get_local_ip():
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return "127.0.0.1"

def get_wifi_signal():
    try:
        if os.path.exists("/proc/net/wireless"):
            with open("/proc/net/wireless", "r") as f:
                lines = f.readlines()
                if len(lines) > 2:
                    parts = lines[2].split()
                    if len(parts) >= 3:
                        val = float(parts[2].replace('.', ''))
                        return min(int(val * 1.4), 100)
        return 0
    except Exception:
        return 0

def get_top_processes():
    grouped = {}
    try:
        for proc in psutil.process_iter(['pid', 'name', 'cpu_percent', 'memory_info']):
            try:
                info = proc.info
                name = info['name']
                if not name:
                    continue
                
                # Group sub-processes into parent executable entries
                name_lower = name.lower()
                if 'brave' in name_lower:
                    norm_name = 'Brave'
                elif 'chrome' in name_lower:
                    norm_name = 'Chrome'
                elif 'steam' in name_lower:
                    norm_name = 'Steam'
                elif 'firefox' in name_lower:
                    norm_name = 'Firefox'
                elif 'discord' in name_lower:
                    norm_name = 'Discord'
                elif 'spotify' in name_lower:
                    norm_name = 'Spotify'
                elif 'python' in name_lower:
                    norm_name = 'Python'
                else:
                    parts = name.split('-')
                    norm_name = ' '.join([p.capitalize() for p in parts])
                
                cpu = info['cpu_percent'] or 0.0
                mem_bytes = info['memory_info'].rss if info['memory_info'] else 0
                mem_mb = mem_bytes / (1024 * 1024)
                
                if norm_name not in grouped:
                    grouped[norm_name] = {
                        'name': norm_name,
                        'cpu': 0.0,
                        'mem': 0.0,
                        'count': 0
                    }
                grouped[norm_name]['cpu'] += cpu
                grouped[norm_name]['mem'] += mem_mb
                grouped[norm_name]['count'] += 1
            except (psutil.NoSuchProcess, psutil.AccessDenied, psutil.ZombieProcess):
                pass
                
        proc_list = []
        for val in grouped.values():
            if val['mem'] < 15.0 or val['name'] in ['Idle', 'System']:
                continue
            proc_list.append(val)
            
        proc_list.sort(key=lambda x: x['mem'], reverse=True)
        return proc_list[:5]
    except Exception:
        return []

def get_gaming_status():
    home = os.path.expanduser("~")
    proton_versions = []
    
    # Check Steam directories for installed proton versions
    paths = [
        os.path.join(home, ".steam/steam/steamapps/common"),
        os.path.join(home, ".steam/root/compatibilitytools.d"),
        os.path.join(home, ".local/share/Steam/steamapps/common")
    ]
    for p in paths:
        if os.path.exists(p):
            try:
                for item in os.listdir(p):
                    if "proton" in item.lower():
                        proton_versions.append(item)
            except Exception:
                pass
                
    proton_str = proton_versions[0] if proton_versions else "Nenhum instalado (Steam indisponível)"
    
    # Check dependencies
    vulkan_status = "Instalado (Ativo)" if shutil.which("vulkaninfo") or os.path.exists("/usr/share/vulkan") else "Não instalado"
    mangohud_status = "Instalado" if shutil.which("mangohud") else "Não instalado"
    gamemode_status = "Inativo"
    
    if shutil.which("gamemoded"):
        gamemode_status = "Instalado (Inativo)"
        # Check if gamemode running
        for proc in psutil.process_iter(['name']):
            if proc.info['name'] == 'gamemoded':
                gamemode_status = "Ativo (Otimizado)"
                break
    else:
        gamemode_status = "Não instalado"
        
    dxvk_status = "Instalado" if os.path.exists("/usr/share/dxvk") or shutil.which("dxvk-setup") else "Não instalado"
    
    return {
        "proton": proton_str,
        "vulkan": vulkan_status,
        "mangohud": mangohud_status,
        "gamemode": gamemode_status,
        "dxvk": dxvk_status
    }

# Battery smoothing variables
battery_watts_smoothed = 0.0
battery_secsleft_smoothed = -1

def get_smoothed_watts(raw_watts):
    global battery_watts_smoothed
    if raw_watts <= 0.0:
        return battery_watts_smoothed
    if battery_watts_smoothed == 0.0:
        battery_watts_smoothed = raw_watts
    else:
        # EMA alpha = 0.15 to filter noise
        battery_watts_smoothed = (raw_watts * 0.15) + (battery_watts_smoothed * 0.85)
    return battery_watts_smoothed

def get_smoothed_secsleft(raw_secs):
    global battery_secsleft_smoothed
    if raw_secs <= -1:
        return battery_secsleft_smoothed
    if battery_secsleft_smoothed == -1:
        battery_secsleft_smoothed = raw_secs
    else:
        # EMA alpha = 0.1 to filter noise
        battery_secsleft_smoothed = (raw_secs * 0.1) + (battery_secsleft_smoothed * 0.9)
    return int(battery_secsleft_smoothed)

def get_battery_info():
    bat_path = None
    for bat in ["BAT0", "BAT1", "BATC"]:
        p = f"/sys/class/power_supply/{bat}"
        if os.path.exists(p):
            bat_path = p
            break
            
    if not bat_path:
        return None
        
    try:
        percent = 100
        capacity_file = os.path.join(bat_path, "capacity")
        if os.path.exists(capacity_file):
            with open(capacity_file, "r") as f:
                percent = int(f.read().strip())
                
        status = "Unknown"
        status_file = os.path.join(bat_path, "status")
        if os.path.exists(status_file):
            with open(status_file, "r") as f:
                status = f.read().strip()
                
        health = 100.0
        cycles = 0
        watts = 0.0
        
        try:
            with open(os.path.join(bat_path, "charge_full"), "r") as f:
                full = int(f.read().strip())
            with open(os.path.join(bat_path, "charge_full_design"), "r") as f:
                design = int(f.read().strip())
            if design > 0:
                health = min(100.0, max(0.0, (full / design) * 100.0))
        except Exception:
            try:
                with open(os.path.join(bat_path, "energy_full"), "r") as f:
                    full = int(f.read().strip())
                with open(os.path.join(bat_path, "energy_full_design"), "r") as f:
                    design = int(f.read().strip())
                if design > 0:
                    health = min(100.0, max(0.0, (full / design) * 100.0))
            except Exception:
                pass
                
        try:
            with open(os.path.join(bat_path, "cycle_count"), "r") as f:
                cycles = int(f.read().strip())
        except Exception:
            pass
            
        raw_watts = 0.0
        try:
            with open(os.path.join(bat_path, "voltage_now"), "r") as f:
                voltage = int(f.read().strip()) / 1e6
            with open(os.path.join(bat_path, "current_now"), "r") as f:
                current = int(f.read().strip()) / 1e6
            raw_watts = voltage * current
        except Exception:
            try:
                with open(os.path.join(bat_path, "power_now"), "r") as f:
                    raw_watts = int(f.read().strip()) / 1e6
            except Exception:
                pass
                
        watts = get_smoothed_watts(raw_watts)
        
        secsleft = -1
        if status.lower() == "discharging" and watts > 0.0:
            energy_now = 0.0
            try:
                with open(os.path.join(bat_path, "energy_now"), "r") as f:
                    energy_now = int(f.read().strip()) / 1e6
                secsleft = (energy_now / watts) * 3600
            except Exception:
                try:
                    with open(os.path.join(bat_path, "charge_now"), "r") as f:
                        charge_now = int(f.read().strip()) / 1e6
                    with open(os.path.join(bat_path, "voltage_now"), "r") as f:
                        voltage = int(f.read().strip()) / 1e6
                    secsleft = ((charge_now * voltage) / watts) * 3600
                except Exception:
                    pass
        elif status.lower() == "charging" and watts > 0.0:
            energy_now = 0.0
            energy_full = 0.0
            try:
                with open(os.path.join(bat_path, "energy_now"), "r") as f:
                    energy_now = int(f.read().strip()) / 1e6
                with open(os.path.join(bat_path, "energy_full"), "r") as f:
                    energy_full = int(f.read().strip()) / 1e6
                secsleft = ((energy_full - energy_now) / watts) * 3600
            except Exception:
                try:
                    with open(os.path.join(bat_path, "charge_now"), "r") as f:
                        charge_now = int(f.read().strip()) / 1e6
                    with open(os.path.join(bat_path, "charge_full"), "r") as f:
                        charge_full = int(f.read().strip()) / 1e6
                    with open(os.path.join(bat_path, "voltage_now"), "r") as f:
                        voltage = int(f.read().strip()) / 1e6
                    secsleft = (((charge_full - charge_now) * voltage) / watts) * 3600
                except Exception:
                    pass
                    
        secsleft = get_smoothed_secsleft(secsleft)
        
        power_mode = "Equilibrado"
        try:
            res = subprocess.run(["powerprofilesctl", "get"], capture_output=True, text=True)
            if res.returncode == 0:
                power_mode = res.stdout.strip().capitalize()
        except Exception:
            pass
            
        return {
            "percent": percent,
            "status": status,
            "health": round(health, 1),
            "cycles": cycles,
            "watts": round(watts, 1),
            "secsleft": secsleft,
            "power_mode": power_mode
        }
    except Exception:
        # Fallback to psutil
        try:
            battery = psutil.sensors_battery()
            if battery:
                return {
                    "percent": battery.percent,
                    "status": "Charging" if battery.power_plugged else "Discharging",
                    "health": 100.0,
                    "cycles": 0,
                    "watts": 0.0,
                    "secsleft": battery.secsleft,
                    "power_mode": "Equilibrado"
                }
        except Exception:
            pass
        return None

cached_system_info = {}

def get_metrics():
    global cached_system_info
    
    net_up, net_down = get_network_speeds()
    cpu_percent = psutil.cpu_percent(interval=None)
    cpu_cores = psutil.cpu_percent(interval=None, percpu=True)
    
    mem = psutil.virtual_memory()
    ram_data = {
        "total": mem.total,
        "used": mem.used,
        "percent": mem.percent,
        "free": mem.free,
        "cached": getattr(mem, "cached", 0) + getattr(mem, "buffers", 0)
    }
    
    gpu_act, gpu_max = get_gpu_freq()
    gpu_percent = 0.0
    if gpu_max > 0:
        gpu_percent = (gpu_act / gpu_max) * 100.0
        
    try:
        disk = psutil.disk_usage('/')
        disk_data = {
            "total": disk.total,
            "used": disk.used,
            "percent": disk.percent,
            "free": disk.free
        }
    except Exception:
        disk_data = {"total": 0, "used": 0, "percent": 0, "free": 0}
        
    if not cached_system_info:
        res, hz = get_display_info()
        cached_system_info = {
            "os": get_os_version(),
            "kernel": platform.release(),
            "cpu_model": get_cpu_model(),
            "gpu_model": "Intel(R) Iris(R) Xe Graphics",
            "resolution": res,
            "refresh_rate": hz
        }
        
    system_data = dict(cached_system_info)
    system_data["uptime"] = get_uptime()
    
    return {
        "cpu": {
            "usage": cpu_percent,
            "cores": cpu_cores,
            "temp": get_smoothed_cpu_temp(),
            "model": system_data["cpu_model"],
            "throttling": get_thermal_throttling(),
            "stress_active": cpu_stress_active
        },
        "ram": ram_data,
        "gpu": {
            "model": system_data["gpu_model"],
            "freq_act": gpu_act,
            "freq_max": gpu_max,
            "percent": gpu_percent,
            "temp": get_smoothed_gpu_temp()
        },
        "system": system_data,
        "network": {
            "up": net_up,
            "down": net_down,
            "local_ip": get_local_ip(),
            "wifi_signal": get_wifi_signal(),
            "ping": ping_ms,
            "jitter": ping_jitter,
            "packet_loss": ping_loss
        },
        "disk": disk_data,
        "battery": get_battery_info(),
        "top_processes": get_top_processes(),
        "gaming": get_gaming_status()
    }

class ControlCenterHTTPHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        base_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'web')
        super().__init__(*args, directory=base_dir, **kwargs)
        
    def do_GET(self):
        if self.path == '/api/metrics':
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Cache-Control', 'no-cache')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            metrics = get_metrics()
            self.wfile.write(json.dumps(metrics).encode('utf-8'))
        else:
            super().do_GET()
            
    def do_POST(self):
        # Stress Test controls
        if self.path == '/api/stress/cpu':
            content_length = int(self.headers['Content-Length'])
            post_data = self.rfile.read(content_length).decode('utf-8')
            try:
                data = json.loads(post_data)
                active = data.get("active", False)
                toggle_cpu_stress(active)
                response = {"status": "success", "cpu_stress_active": cpu_stress_active}
            except Exception as e:
                response = {"status": "error", "message": str(e)}
                
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            self.wfile.write(json.dumps(response).encode('utf-8'))
            
        # Embedded Terminal Command Runner
        elif self.path == '/api/terminal':
            content_length = int(self.headers['Content-Length'])
            post_data = self.rfile.read(content_length).decode('utf-8')
            try:
                data = json.loads(post_data)
                cmd = data.get("command", "")
                
                # Execute in user shell context (timeout 5s to avoid hangs)
                res = subprocess.run(
                    cmd,
                    shell=True,
                    cwd=os.path.expanduser("~"),
                    capture_output=True,
                    text=True,
                    timeout=5.0
                )
                response = {
                    "stdout": res.stdout,
                    "stderr": res.stderr,
                    "exit_code": res.returncode
                }
            except subprocess.TimeoutExpired:
                response = {
                    "stdout": "",
                    "stderr": "Comando expirou (limite de 5 segundos excedido).",
                    "exit_code": 124
                }
            except Exception as e:
                response = {
                    "stdout": "",
                    "stderr": str(e),
                    "exit_code": 1
                }
                
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            self.wfile.write(json.dumps(response).encode('utf-8'))
        else:
            self.send_response(404)
            self.end_headers()

    def log_message(self, format, *args):
        pass

def start_server(port):
    server = http.server.ThreadingHTTPServer(('127.0.0.1', port), ControlCenterHTTPHandler)
    server.serve_forever()

def get_free_port():
    s = socket.socket()
    s.bind(('127.0.0.1', 0))
    port = s.getsockname()[1]
    s.close()
    return port

class LinuxControlCenterApp(Gtk.Application):
    def __init__(self, port):
        super().__init__(application_id='org.linuxmint.controlcenter')
        self.port = port
        
    def do_activate(self):
        win = Gtk.ApplicationWindow(application=self)
        win.set_title("Linux Gaming Control Center")
        win.set_default_size(1280, 850)
        
        webview = WebKit.WebView()
        settings = webview.get_settings()
        settings.set_enable_developer_extras(True)
        settings.set_enable_webgl(True)
        settings.set_enable_write_console_messages_to_stdout(True)
        
        webview.load_uri(f"http://127.0.0.1:{self.port}/index.html")
        
        win.set_child(webview)
        win.present()

def main():
    port = get_free_port()
    
    # Start latency checker in background
    ping_thread = threading.Thread(target=ping_worker, daemon=True)
    ping_thread.start()
    
    # Start web assets and api server
    server_thread = threading.Thread(target=start_server, args=(port,), daemon=True)
    server_thread.start()
    
    time.sleep(0.15)
    
    app = LinuxControlCenterApp(port)
    sys.exit(app.run(None))

if __name__ == '__main__':
    main()

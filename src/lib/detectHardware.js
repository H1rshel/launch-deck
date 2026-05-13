/**
 * Hardware detection service.
 * Calls the Tauri `detect_hardware` command and normalizes the result
 * into a structured hardware snapshot for the scoring engine.
 */

import { invoke } from '@tauri-apps/api/core'
import {
  normalizeCpuName,
  normalizeGpuName,
  detectCpuFamily,
  detectGpuFamily,
} from './normalizeHardware'

const isTauri =
  typeof window !== 'undefined' &&
  !!(window.__TAURI_INTERNALS__ || window.__TAURI__)

/**
 * Detect hardware using the Tauri backend.
 * Returns a normalized snapshot ready for the scoring engine.
 */
export async function detectHardware() {
  if (!isTauri) {
    return getDemoSnapshot()
  }

  try {
    const raw = await invoke('detect_hardware')
    return normalizeSnapshot(raw)
  } catch (err) {
    console.error('Hardware detection failed:', err)
    return null
  }
}

function normalizeSnapshot(raw) {
  const cpu = raw.cpu
    ? {
        rawName: raw.cpu.raw_name,
        normalizedName: normalizeCpuName(raw.cpu.raw_name),
        cores: raw.cpu.cores,
        threads: raw.cpu.threads,
        maxClockMhz: raw.cpu.max_clock_mhz,
        family: detectCpuFamily(normalizeCpuName(raw.cpu.raw_name)),
      }
    : null

  // Pick the best discrete GPU (highest VRAM), or first if tied
  const allGpus = (raw.gpus || []).map((g) => ({
    rawName: g.raw_name,
    normalizedName: normalizeGpuName(g.raw_name),
    vramGb: Math.round((g.vram_bytes || 0) / (1024 * 1024 * 1024) * 10) / 10,
    driverVersion: g.driver_version,
    family: detectGpuFamily(normalizeGpuName(g.raw_name)),
  }))

  // Prefer discrete GPU (non-Intel integrated)
  const discreteGpus = allGpus.filter(
    (g) => !g.rawName.toLowerCase().includes('intel') || g.rawName.toLowerCase().includes('arc'),
  )
  const gpu = discreteGpus[0] || allGpus[0] || null

  const totalRamGb = raw.ram
    ? Math.round((raw.ram.total_bytes / (1024 * 1024 * 1024)) * 10) / 10
    : 0

  const ram = raw.ram
    ? {
        totalGb: totalRamGb,
        speedMhz: raw.ram.speed_mhz,
      }
    : null

  const storage = (raw.storage || []).map((d) => ({
    model: d.model,
    sizeGb: Math.round((d.size_bytes || 0) / (1024 * 1024 * 1024)),
    type: d.media_type,
    isSystemDrive: d.is_system_drive,
  }))

  const display = raw.display
    ? {
        resolution: `${raw.display.width}x${raw.display.height}`,
        width: raw.display.width,
        height: raw.display.height,
        refreshRate: raw.display.refresh_rate,
      }
    : null

  const os = raw.os
    ? {
        name: raw.os.name,
        version: raw.os.version,
        build: raw.os.build,
      }
    : null

  return {
    cpu,
    gpu,
    allGpus,
    ram,
    storage,
    display,
    os,
    platformType: raw.platform_type || 'unknown',
    motherboard: raw.motherboard || '',
    detectedAt: new Date().toISOString(),
  }
}

/**
 * Demo snapshot for non-Tauri (browser dev) environments.
 */
function getDemoSnapshot() {
  return {
    cpu: {
      rawName: 'AMD Ryzen 7 7800X3D 8-Core Processor',
      normalizedName: 'Ryzen 7 7800X3D',
      cores: 8,
      threads: 16,
      maxClockMhz: 4500,
      family: 'amd_ryzen_7',
    },
    gpu: {
      rawName: 'NVIDIA GeForce RTX 4070 SUPER',
      normalizedName: 'RTX 4070 SUPER',
      vramGb: 12,
      driverVersion: '560.94',
      family: 'nvidia_rtx_40',
    },
    allGpus: [
      {
        rawName: 'NVIDIA GeForce RTX 4070 SUPER',
        normalizedName: 'RTX 4070 SUPER',
        vramGb: 12,
        driverVersion: '560.94',
        family: 'nvidia_rtx_40',
      },
    ],
    ram: { totalGb: 32, speedMhz: 6000 },
    storage: [
      { model: 'Samsung 990 Pro 2TB', sizeGb: 2000, type: 'nvme', isSystemDrive: true },
      { model: 'WD Black SN850X 1TB', sizeGb: 1000, type: 'nvme', isSystemDrive: false },
    ],
    display: { resolution: '2560x1440', width: 2560, height: 1440, refreshRate: 165 },
    os: { name: 'Microsoft Windows 11 Pro', version: '10.0.26200', build: '26200' },
    platformType: 'desktop',
    motherboard: 'ASUS ROG STRIX B650E-F',
    detectedAt: new Date().toISOString(),
  }
}

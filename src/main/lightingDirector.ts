import { analyzeMonoPcm } from '../shared/audioAnalysis.js'
import { buildLightingProgram, resolveActiveCues, nextLightingCue } from '../shared/lightingProgram.js'
import type { LightingCue } from '../shared/lightingProgram.js'
import { LiveBeatSync } from '../shared/liveAudioSync.js'
import type { ClickTrackSettings, LightingProgram, SetlistItem, SongAudioAnalysis } from '../shared/types.js'
import { decodeAudioFileToMonoPcm } from './audioDecode.js'
import { writeClickTrackWav } from './clickTrackWav.js'
import { clickTrackPathForSong } from './clickTrackPaths.js'
import { LiveAudioCapture } from './liveAudioCapture.js'

export type LightingDirectorSnapshot = {
  active: boolean
  songId: string | null
  performanceMs: number
  syncOffsetMs: number
  activeCueLabel: string | null
  activePatternId: number | null
  nextCueAtMs: number | null
  liveAudioCapturing: boolean
  analyzingSongId: string | null
  analyzeError: string | null
}

export type ApplyCueFn = (cue: LightingCue) => void

export type AnalyzeSongResult = {
  audioAnalysis: SongAudioAnalysis
  lightingProgram: LightingProgram
  clickTrackPath?: string
  clickTrackCountInMs?: number
}

export class LightingDirector {
  private active = false
  private songId: string | null = null
  private program: LightingProgram | null = null
  private analysis: SongAudioAnalysis | null = null
  private lastAppliedKey: string | null = null
  private analyzingSongId: string | null = null
  private analyzeError: string | null = null
  private readonly beatSync = new LiveBeatSync()
  private readonly liveCapture = new LiveAudioCapture(this.beatSync)
  private applyCue: ApplyCueFn = () => {}

  setApplyCue(fn: ApplyCueFn): void {
    this.applyCue = fn
  }

  snapshot(): LightingDirectorSnapshot {
    const perf = this.beatSync.adjustedPerformanceMs(this.rawPerformanceMs)
    const state = resolveActiveCues(this.program ?? undefined, perf)
    const cue = state ? state.accent ?? state.base : null
    const next = nextLightingCue(this.program ?? undefined, perf)
    return {
      active: this.active,
      songId: this.songId,
      performanceMs: Math.round(perf),
      syncOffsetMs: Math.round(this.beatSync.getSyncOffsetMs()),
      activeCueLabel: cue?.label ?? null,
      activePatternId: cue?.ledPatternId ?? null,
      nextCueAtMs: next?.atMs ?? null,
      liveAudioCapturing: this.liveCapture.capturing,
      analyzingSongId: this.analyzingSongId,
      analyzeError: this.analyzeError
    }
  }

  private rawPerformanceMs = 0

  tick(performanceMs: number): void {
    this.rawPerformanceMs = performanceMs
    this.beatSync.setPerformanceMs(performanceMs)
    if (!this.active || !this.program) return

    const adjusted = this.beatSync.adjustedPerformanceMs(performanceMs)
    const state = resolveActiveCues(this.program, adjusted)
    if (!state) return
    const cue = state.accent ?? state.base
    const key = `${cue.atMs}:${cue.ledPatternId}:${cue.label ?? ''}:${state.accent ? 'a' : 'b'}`
    if (key === this.lastAppliedKey) return
    this.lastAppliedKey = key
    this.applyCue(cue)
  }

  arm(song: SetlistItem | null, liveAudio: boolean, loopbackDevice?: string): void {
    this.disarm(false)
    if (!song?.lightingProgram?.cues?.length) {
      this.active = false
      return
    }
    this.active = true
    this.songId = song.id
    this.program = song.lightingProgram
    this.analysis = song.audioAnalysis ?? null
    this.lastAppliedKey = null
    this.rawPerformanceMs = 0
    this.beatSync.setAnalysis(this.analysis)
    this.beatSync.resetPerformance(0)

    if (liveAudio && this.analysis) {
      this.liveCapture.start({
        deviceName: loopbackDevice,
        onError: (msg) => console.warn('[ViewerOne] Live audio:', msg)
      })
    }
  }

  disarm(stopLiveAudio = true): void {
    this.active = false
    this.songId = null
    this.program = null
    this.analysis = null
    this.lastAppliedKey = null
    this.rawPerformanceMs = 0
    if (stopLiveAudio) this.liveCapture.stop()
    this.beatSync.setAnalysis(null)
  }

  shutdown(): void {
    this.disarm(true)
  }

  async analyzeFromRenderWav(
    song: SetlistItem,
    wavPath: string,
    clickSettings: ClickTrackSettings
  ): Promise<AnalyzeSongResult> {
    this.analyzingSongId = song.id
    this.analyzeError = null
    try {
      const { samples, sampleRate, durationMs } = await decodeAudioFileToMonoPcm(wavPath, 48000)
      const audioAnalysis = analyzeMonoPcm(samples, sampleRate, durationMs, song.title)
      const lightingProgram = buildLightingProgram(audioAnalysis)
      let clickTrackPath: string | undefined
      let clickTrackCountInMs: number | undefined
      if (clickSettings.generateWav) {
        const clickPath = clickTrackPathForSong(song.program, song.title)
        const written = writeClickTrackWav(clickPath, audioAnalysis, {
          volume: clickSettings.volume,
          accentVolume: clickSettings.accentVolume,
          accentEvery: clickSettings.accentEvery,
          countInBars: 1,
          embedCountIn: true,
          sampleRate: 48000,
          durationSamples: samples.length
        })
        clickTrackPath = written.path
        clickTrackCountInMs = written.countInMs
      }
      return { audioAnalysis, lightingProgram, clickTrackPath, clickTrackCountInMs }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      this.analyzeError = msg
      throw e
    } finally {
      this.analyzingSongId = null
    }
  }

  async analyzeSongBackingTrack(
    song: SetlistItem,
    clickSettings: ClickTrackSettings
  ): Promise<AnalyzeSongResult> {
    if (!song.backingTrackPath) {
      throw new Error('No backing track path set for this song.')
    }
    return this.analyzeFromRenderWav(song, song.backingTrackPath, clickSettings)
  }
}

import { analyzeMonoPcm } from '../shared/audioAnalysis.js'
import { buildLightingProgram, activeLightingCue, nextLightingCue } from '../shared/lightingProgram.js'
import { LiveBeatSync } from '../shared/liveAudioSync.js'
import type { LightingProgram, SetlistItem, SongAudioAnalysis } from '../shared/types.js'
import { decodeAudioFileToMonoPcm } from './audioDecode.js'
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

export type ApplyPatternFn = (patternId: number, brightness?: number, dmxLook?: 'off' | 'idle' | 'live') => void

export class LightingDirector {
  private active = false
  private songId: string | null = null
  private program: LightingProgram | null = null
  private analysis: SongAudioAnalysis | null = null
  private lastAppliedPatternId: number | null = null
  private analyzingSongId: string | null = null
  private analyzeError: string | null = null
  private readonly beatSync = new LiveBeatSync()
  private readonly liveCapture = new LiveAudioCapture(this.beatSync)
  private applyPattern: ApplyPatternFn = () => {}

  setApplyPattern(fn: ApplyPatternFn): void {
    this.applyPattern = fn
  }

  snapshot(): LightingDirectorSnapshot {
    const perf = this.beatSync.adjustedPerformanceMs(this.rawPerformanceMs)
    const cue = activeLightingCue(this.program ?? undefined, perf)
    const next = nextLightingCue(this.program ?? undefined, perf)
    return {
      active: this.active,
      songId: this.songId,
      performanceMs: Math.round(perf),
      syncOffsetMs: Math.round(this.beatSync.getSyncOffsetMs()),
      activeCueLabel: cue?.label ?? null,
      activePatternId: cue?.ledPatternId ?? this.lastAppliedPatternId,
      nextCueAtMs: next?.atMs ?? null,
      liveAudioCapturing: this.liveCapture.capturing,
      analyzingSongId: this.analyzingSongId,
      analyzeError: this.analyzeError
    }
  }

  private rawPerformanceMs = 0

  /** Update performance clock from countdown (elapsed ms from song start). */
  tick(performanceMs: number): void {
    this.rawPerformanceMs = performanceMs
    this.beatSync.setPerformanceMs(performanceMs)
    if (!this.active || !this.program) return

    const adjusted = this.beatSync.adjustedPerformanceMs(performanceMs)
    const cue = activeLightingCue(this.program, adjusted)
    if (!cue) return
    if (cue.ledPatternId === this.lastAppliedPatternId) return
    this.lastAppliedPatternId = cue.ledPatternId
    this.applyPattern(cue.ledPatternId, cue.brightness, cue.dmxLook)
  }

  arm(song: SetlistItem | null, liveAudio: boolean): void {
    this.disarm(false)
    if (!song?.lightingProgram?.cues?.length) {
      this.active = false
      return
    }
    this.active = true
    this.songId = song.id
    this.program = song.lightingProgram
    this.analysis = song.audioAnalysis ?? null
    this.lastAppliedPatternId = null
    this.rawPerformanceMs = 0
    this.beatSync.setAnalysis(this.analysis)
    this.beatSync.resetPerformance(0)

    if (liveAudio && this.analysis) {
      this.liveCapture.start({
        onError: (msg) => console.warn('[ViewerOne] Live audio:', msg)
      })
    }
  }

  disarm(stopLiveAudio = true): void {
    this.active = false
    this.songId = null
    this.program = null
    this.analysis = null
    this.lastAppliedPatternId = null
    this.rawPerformanceMs = 0
    if (stopLiveAudio) this.liveCapture.stop()
    this.beatSync.setAnalysis(null)
  }

  shutdown(): void {
    this.disarm(true)
  }

  async analyzeSongBackingTrack(song: SetlistItem): Promise<{
    audioAnalysis: SongAudioAnalysis
    lightingProgram: LightingProgram
  }> {
    if (!song.backingTrackPath) {
      throw new Error('No backing track path set for this song.')
    }
    this.analyzingSongId = song.id
    this.analyzeError = null
    try {
      const { samples, sampleRate, durationMs } = await decodeAudioFileToMonoPcm(
        song.backingTrackPath
      )
      const audioAnalysis = analyzeMonoPcm(samples, sampleRate, durationMs)
      const lightingProgram = buildLightingProgram(audioAnalysis)
      return { audioAnalysis, lightingProgram }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      this.analyzeError = msg
      throw e
    } finally {
      this.analyzingSongId = null
    }
  }
}

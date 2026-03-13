import { useEffect, useRef, useState } from 'react';
import type { AudioControls } from '../../hooks/useAudio';
import type { SoundEffect } from '../../lib/audio';

interface SplashScreenProps {
  onComplete: () => void;
  audio?: AudioControls;
}

const BOOT_LINES = [
  'TAC_VIEW TACTICAL INTELLIGENCE SYSTEM',
  '======================================',
  '',
  'INITIALISING CESIUM 3D ENGINE............ OK',
  'LOADING GOOGLE PHOTOREALISTIC 3D TILES.. OK',
  'CONNECTING OPENSKY NETWORK.............. OK',
  'LOADING CELESTRAK SATELLITE DATA........ OK',
  'CONNECTING USGS SEISMIC FEED............ OK',
  'CONNECTING GLOBAL CCTV NETWORK.......... OK',
  'COMPILING POST-PROCESSING SHADERS....... OK',
  'BUILDING TACTICAL DISPLAY OVERLAY....... OK',
  '',
  'ALL SYSTEMS NOMINAL',
  '',
  'PRESS ANY KEY OR WAIT TO ENTER',
];

const CHAR_SPEED = 12;

function getSoundForLine(line: string): SoundEffect | null {
  if (line.length === 0) return null;
  if (line.includes('TAC_VIEW')) return 'bootSweep';
  if (line.includes('====')) return 'bootSeparator';
  if (line.includes('NOMINAL')) return 'bootReady';
  if (line.includes('PRESS')) return 'bootOk';
  if (line.includes('CONNECTING')) return 'bootConnect';
  if (line.includes('LOADING') || line.includes('COMPILING') || line.includes('BUILDING') || line.includes('INITIALISING')) {
    return 'bootLoad';
  }
  return 'bootTick';
}

function getLineClass(line: string): string {
  if (line.includes('OK')) return 'text-wv-green';
  if (line.includes('PRESS')) return 'text-wv-cyan glow-cyan animate-pulse';
  if (line.includes('====')) return 'text-wv-border';
  if (line.includes('NOMINAL')) return 'text-wv-green glow-green font-bold';
  if (line.includes('TAC_VIEW')) return 'text-wv-cyan glow-cyan font-bold text-sm';
  return 'text-wv-muted';
}

export default function SplashScreen({ onComplete, audio }: SplashScreenProps) {
  const [visibleLines, setVisibleLines] = useState(0);
  const [typedChars, setTypedChars] = useState(0);
  const soundPlayedRef = useRef<Set<number>>(new Set());
  const automationMode =
    typeof navigator !== 'undefined' &&
    navigator.webdriver === true;
  const maxSplashDurationMs = automationMode ? 2_000 : 8_000;

  const currentLine = BOOT_LINES[visibleLines] ?? '';
  const isTypingLine = visibleLines < BOOT_LINES.length && currentLine.length > 0;
  const isFullyTyped = typedChars >= currentLine.length;
  const ready = visibleLines >= BOOT_LINES.length;

  useEffect(() => {
    if (visibleLines >= BOOT_LINES.length) return;
    if (soundPlayedRef.current.has(visibleLines)) return;

    const sound = getSoundForLine(BOOT_LINES[visibleLines]);
    if (!sound) return;

    soundPlayedRef.current.add(visibleLines);
    audio?.play(sound);
  }, [audio, visibleLines]);

  useEffect(() => {
    if (ready) return;

    const line = BOOT_LINES[visibleLines];

    if (line === '') {
      const timer = window.setTimeout(() => {
        setTypedChars(0);
        setVisibleLines((value) => value + 1);
      }, 80);
      return () => window.clearTimeout(timer);
    }

    if (typedChars < line.length) {
      const timer = window.setTimeout(() => {
        setTypedChars((value) => value + 1);
      }, CHAR_SPEED + Math.random() * 8);
      return () => window.clearTimeout(timer);
    }

    const pauseMs = line.includes('NOMINAL') ? 400 : line.includes('TAC_VIEW') ? 300 : 120;
    const timer = window.setTimeout(() => {
      setTypedChars(0);
      setVisibleLines((value) => value + 1);
    }, pauseMs);
    return () => window.clearTimeout(timer);
  }, [ready, typedChars, visibleLines]);

  useEffect(() => {
    if (!ready) return;

    const handleComplete = () => onComplete();
    const autoAdvanceDelay = automationMode ? 250 : 1500;
    const autoAdvanceTimer = window.setTimeout(handleComplete, autoAdvanceDelay);

    window.addEventListener('keydown', handleComplete);
    window.addEventListener('click', handleComplete);

    return () => {
      window.clearTimeout(autoAdvanceTimer);
      window.removeEventListener('keydown', handleComplete);
      window.removeEventListener('click', handleComplete);
    };
  }, [automationMode, onComplete, ready]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      onComplete();
    }, maxSplashDurationMs);

    return () => window.clearTimeout(timer);
  }, [maxSplashDurationMs, onComplete]);

  return (
    <div className="fixed inset-0 bg-wv-black z-[100] flex items-center justify-center">
      <div className="w-full max-w-xl p-8">
        {BOOT_LINES.slice(0, visibleLines).map((line, index) => (
          <div
            key={`${line}-${index}`}
            className={`text-[11px] leading-relaxed ${getLineClass(line)}`}
          >
            {line || '\u00A0'}
          </div>
        ))}

        {isTypingLine && (
          <div className={`text-[11px] leading-relaxed ${getLineClass(currentLine)}`}>
            {currentLine.slice(0, typedChars)}
            {!isFullyTyped && (
              <span className="inline-block w-[6px] h-[11px] bg-wv-green ml-[1px] animate-pulse align-middle" />
            )}
          </div>
        )}

        {!ready && !isTypingLine && (
          <span className="inline-block w-2 h-3 bg-wv-green animate-pulse" />
        )}
      </div>
    </div>
  );
}

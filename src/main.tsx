import React from 'react';
import ReactDOM from 'react-dom/client';
import { Download, FileAudio, Headphones, Loader2, Music2, Play, RefreshCw, Sparkles, UploadCloud } from 'lucide-react';
import { FFmpeg } from '@ffmpeg/ffmpeg';
import { fetchFile, toBlobURL } from '@ffmpeg/util';
import './styles.css';

type AudioState = {
  file: File | null;
  originalUrl: string;
  processedUrl: string;
  outputName: string;
  peaks: number[];
  status: string;
  error: string;
  phase: 'idle' | 'ready' | 'processing' | 'done' | 'error';
  activePreview: 'original' | 'processed';
};

const initialState: AudioState = {
  file: null,
  originalUrl: '',
  processedUrl: '',
  outputName: '',
  peaks: [],
  status: 'Drop audio or choose a file',
  error: '',
  phase: 'idle',
  activePreview: 'original'
};

const formatBytes = (bytes: number) => {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** index).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
};

const getExtension = (fileName: string) => {
  const match = fileName.match(/\.([a-z0-9]+)$/i);
  return match ? match[1].toLowerCase() : 'mp3';
};

const getOutputName = (fileName: string) => {
  const extension = getExtension(fileName);
  const base = fileName.replace(/\.[^/.]+$/, '') || 'track';
  return `${base}-atmos.${extension}`;
};

const getErrorMessage = (error: unknown) => {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string' && error.trim()) return error;
  return 'Unable to process this file.';
};

const buildFfmpegArgs = (inputName: string, outputName: string, extension: string) => {
  const filter = [
    'atempo=0.88',
    'aecho=0.82:0.34:92|210:0.13|0.055',
    'equalizer=f=75:t=q:w=1.0:g=1.9',
    'equalizer=f=260:t=q:w=1.2:g=0.8',
    'equalizer=f=520:t=q:w=1.0:g=-0.8',
    'equalizer=f=3300:t=q:w=1.4:g=0.7',
    'equalizer=f=8800:t=q:w=1.0:g=0.9',
    'acompressor=threshold=-18dB:ratio=1.65:attack=38:release=360:makeup=1.1',
    'alimiter=limit=0.94'
  ].join(',');

  const common = ['-i', inputName, '-vn', '-map', '0:a:0', '-filter:a', filter];

  if (extension === 'mp3') return [...common, '-codec:a', 'libmp3lame', '-b:a', '192k', outputName];
  if (extension === 'wav') return [...common, '-codec:a', 'pcm_s16le', outputName];
  if (extension === 'ogg') return [...common, '-codec:a', 'libvorbis', '-q:a', '5', outputName];
  if (extension === 'm4a' || extension === 'aac') return [...common, '-codec:a', 'aac', '-b:a', '192k', outputName];

  return [...common, outputName];
};

const createPeaks = async (file: File) => {
  const arrayBuffer = await file.arrayBuffer();
  const context = new AudioContext();
  const decoded = await context.decodeAudioData(arrayBuffer.slice(0));
  const channel = decoded.getChannelData(0);
  const bars = 96;
  const block = Math.floor(channel.length / bars);
  const peaks = Array.from({ length: bars }, (_, index) => {
    let sum = 0;
    const start = index * block;
    for (let i = 0; i < block; i += 1) sum += Math.abs(channel[start + i] || 0);
    return Math.min(1, Math.sqrt(sum / Math.max(block, 1)) * 3.4);
  });
  await context.close();
  return peaks;
};

const ffmpeg = new FFmpeg();
let ffmpegLoaded = false;
let lastFfmpegMessage = '';

const loadFfmpeg = async (setStatus: (status: string) => void) => {
  if (ffmpegLoaded) return;
  setStatus('Loading audio engine');
  const baseUrl = '/ffmpeg-core';
  ffmpeg.on('log', ({ message }) => {
    lastFfmpegMessage = message;
    if (message.includes('time=')) setStatus('Processing track');
  });
  await ffmpeg.load({
    coreURL: await toBlobURL(`${baseUrl}/ffmpeg-core.js`, 'text/javascript'),
    wasmURL: await toBlobURL(`${baseUrl}/ffmpeg-core.wasm`, 'application/wasm')
  });
  ffmpegLoaded = true;
};

function App() {
  const [state, setState] = React.useState<AudioState>(initialState);
  const fileInputRef = React.useRef<HTMLInputElement>(null);
  const urlsRef = React.useRef({ originalUrl: '', processedUrl: '' });

  React.useEffect(() => {
    return () => {
      if (urlsRef.current.originalUrl) URL.revokeObjectURL(urlsRef.current.originalUrl);
      if (urlsRef.current.processedUrl) URL.revokeObjectURL(urlsRef.current.processedUrl);
    };
  }, []);

  const patch = (partial: Partial<AudioState>) => setState((current) => ({ ...current, ...partial }));

  const acceptFile = async (file: File | undefined) => {
    if (!file) return;
    if (!file.type.startsWith('audio/') && !/\.(mp3|wav|m4a|aac|ogg|flac)$/i.test(file.name)) {
      patch({ phase: 'error', error: 'Choose an audio file: MP3, WAV, M4A, AAC, OGG, FLAC, or a similar format.' });
      return;
    }
    if (urlsRef.current.originalUrl) URL.revokeObjectURL(urlsRef.current.originalUrl);
    if (urlsRef.current.processedUrl) URL.revokeObjectURL(urlsRef.current.processedUrl);
    const originalUrl = URL.createObjectURL(file);
    urlsRef.current = { originalUrl, processedUrl: '' };
    patch({
      file,
      originalUrl,
      processedUrl: '',
      outputName: getOutputName(file.name),
      peaks: [],
      phase: 'ready',
      activePreview: 'original',
      status: 'Ready to process',
      error: ''
    });
    try {
      const peaks = await createPeaks(file);
      patch({ peaks });
    } catch {
      patch({ peaks: Array.from({ length: 96 }, (_, index) => 0.18 + ((index * 13) % 31) / 100) });
    }
  };

  const processAudio = async () => {
    if (!state.file) return;
    patch({ phase: 'processing', status: 'Preparing effect chain', error: '' });
    try {
      await loadFfmpeg((status) => patch({ status }));
      const extension = getExtension(state.file.name);
      const inputName = `input.${extension}`;
      const outputName = getOutputName(state.file.name);
      lastFfmpegMessage = '';
      await ffmpeg.writeFile(inputName, await fetchFile(state.file));
      patch({ status: 'Adding warm slowed atmosphere' });
      const exitCode = await ffmpeg.exec(buildFfmpegArgs(inputName, outputName, extension));
      if (exitCode !== 0) throw new Error(lastFfmpegMessage || `FFmpeg exited with code ${exitCode}`);
      const data = await ffmpeg.readFile(outputName);
      const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
      const payload = new Uint8Array(bytes.length);
      payload.set(bytes);
      const blob = new Blob([payload], { type: state.file.type || 'audio/mpeg' });
      const processedUrl = URL.createObjectURL(blob);
      if (urlsRef.current.processedUrl) URL.revokeObjectURL(urlsRef.current.processedUrl);
      urlsRef.current.processedUrl = processedUrl;
      await ffmpeg.deleteFile(inputName);
      await ffmpeg.deleteFile(outputName);
      patch({
        processedUrl,
        outputName,
        phase: 'done',
        activePreview: 'processed',
        status: 'Done'
      });
    } catch (error) {
      patch({
        phase: 'error',
        error: getErrorMessage(error),
        status: 'Processing failed'
      });
    }
  };

  const activeUrl = state.activePreview === 'processed' && state.processedUrl ? state.processedUrl : state.originalUrl;

  return (
    <main className="shell">
      <section className="topbar">
        <div className="brand">
          <div className="brandMark"><Music2 size={20} /></div>
          <div>
            <h1>Atmos Audio</h1>
            <p>slowed + reverb studio utility</p>
          </div>
        </div>
        <div className="topActions">
          <span className={`signal ${state.phase}`}>{state.status}</span>
          <button className="ghostButton" onClick={() => fileInputRef.current?.click()}>
            <UploadCloud size={17} />
            Choose file
          </button>
        </div>
      </section>

      <section className="workspace">
        <aside className="panel uploadPanel">
          <input ref={fileInputRef} type="file" accept="audio/*,.mp3,.wav,.m4a,.aac,.ogg,.flac" onChange={(event) => acceptFile(event.target.files?.[0])} />
          <button
            className="dropZone"
            onClick={() => fileInputRef.current?.click()}
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => {
              event.preventDefault();
              acceptFile(event.dataTransfer.files[0]);
            }}
          >
            <UploadCloud size={34} />
            <strong>Upload audio</strong>
            <span>MP3, WAV, M4A, AAC, OGG, FLAC</span>
          </button>

          <div className="fileCard">
            <div className="fileIcon"><FileAudio size={20} /></div>
            <div>
              <strong>{state.file?.name || 'No file selected'}</strong>
              <span>{state.file ? `${formatBytes(state.file.size)} · ${getExtension(state.file.name).toUpperCase()}` : 'Waiting for upload'}</span>
            </div>
          </div>

          <div className="miniStats">
            <div><span>Tempo</span><strong>-12%</strong></div>
            <div><span>Room</span><strong>warm</strong></div>
            <div><span>Peak</span><strong>-0.5dB</strong></div>
          </div>
        </aside>

        <section className="stage">
          <div className="waveHeader">
            <div>
              <p>Processing</p>
              <h2>{state.file ? state.file.name.replace(/\.[^/.]+$/, '') : 'Your track will appear here'}</h2>
            </div>
            <div className="previewToggle">
              <button className={state.activePreview === 'original' ? 'selected' : ''} onClick={() => patch({ activePreview: 'original' })}>Before</button>
              <button className={state.activePreview === 'processed' ? 'selected' : ''} onClick={() => patch({ activePreview: 'processed' })} disabled={!state.processedUrl}>After</button>
            </div>
          </div>

          <div className="waveform">
            {(state.peaks.length ? state.peaks : Array.from({ length: 96 }, (_, index) => 0.12 + ((index * 17) % 47) / 100)).map((peak, index) => (
              <span key={index} style={{ height: `${18 + peak * 74}%`, opacity: state.file ? 1 : 0.28 }} />
            ))}
            {state.phase === 'processing' && <div className="processingVeil"><Loader2 className="spin" size={32} />Creating atmosphere</div>}
          </div>

          <div className="playerStrip">
            <div className="playBadge"><Headphones size={18} /></div>
            {activeUrl ? <audio key={activeUrl} controls src={activeUrl} /> : <div className="emptyPlayer">Upload audio to enable preview</div>}
          </div>
          {state.error && <div className="errorBox">{state.error}</div>}
        </section>
      </section>

      <section className="transport">
        <div className="transportInfo">
          <button className="roundButton" disabled={!activeUrl}>
            <Play size={19} fill="currentColor" />
          </button>
          <div>
            <strong>{state.phase === 'done' ? 'Atmos version ready' : 'Ready for studio-style processing'}</strong>
            <span>{state.outputName || 'The file will keep its original extension'}</span>
          </div>
        </div>
        <div className="transportActions">
          <button className="secondaryButton" onClick={() => state.file && acceptFile(state.file)} disabled={!state.file || state.phase === 'processing'}>
            <RefreshCw size={17} />
            Reset
          </button>
          <button className="primaryButton" onClick={processAudio} disabled={!state.file || state.phase === 'processing'}>
            {state.phase === 'processing' ? <Loader2 className="spin" size={18} /> : <Sparkles size={18} />}
            Process
          </button>
          <a className={`downloadButton ${state.processedUrl ? '' : 'disabled'}`} href={state.processedUrl || undefined} download={state.outputName || undefined}>
            <Download size={18} />
            Download
          </a>
        </div>
      </section>
    </main>
  );
}

ReactDOM.createRoot(document.getElementById('root')!).render(<App />);

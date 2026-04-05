/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useRef, useEffect, useMemo } from 'react';
import { Mic, Upload, Play, Square, MessageSquare, FileText, Trash2, Loader2, MicOff, Clock, HardDrive, AlertCircle, Volume2, X, Rewind, FastForward, Settings as SettingsIcon } from 'lucide-react';
import Markdown from 'react-markdown';
import { uploadPDF, generateEpisode, textToSpeech } from './services/harvestService';

class TTSPlayer {
  private voices: SpeechSynthesisVoice[] = [];

  constructor() {
    if (typeof window !== 'undefined' && window.speechSynthesis) {
      this.loadVoices();
      window.speechSynthesis.onvoiceschanged = () => this.loadVoices();
    }
  }

  private loadVoices() {
    this.voices = window.speechSynthesis.getVoices();
  }

  private getVoice(lang: string) {
    // Try to find a South African voice first
    const zaVoice = this.voices.find(v => v.lang === 'en-ZA');
    if (zaVoice) return zaVoice;
    
    // Fallback to any English voice
    return this.voices.find(v => v.lang.startsWith('en')) || null;
  }

  private stripMarkdown(text: string): string {
    return text
      .replace(/(\*\*|__)(.*?)\1/g, '$2') // bold
      .replace(/(\*|_)(.*?)\1/g, '$2')    // italic
      .replace(/\[(.*?)\]\(.*?\)/g, '$1') // links
      .replace(/`{1,3}.*?`{1,3}/g, '')    // code
      .replace(/[#*>-]/g, '')             // headers, lists
      .trim();
  }

  speak(text: string, config: { pitch: number; rate: number; onEnd?: () => void; onError?: (e?: any) => void }) {
    if (typeof window === 'undefined' || !window.speechSynthesis) {
      if (config.onError) config.onError(new Error("Speech synthesis not supported"));
      return;
    }
    
    const synth = window.speechSynthesis;
    
    // Mobile browser workaround: resume if paused/stuck
    if (synth.paused) {
      synth.resume();
    }
    
    const cleanText = this.stripMarkdown(text);
    if (!cleanText) {
      if (config.onEnd) config.onEnd();
      return;
    }

    const utterance = new SpeechSynthesisUtterance(cleanText);
    
    const voice = this.getVoice('en-ZA');
    if (voice) utterance.voice = voice;
    
    utterance.pitch = config.pitch;
    utterance.rate = config.rate;
    
    if (config.onEnd) utterance.onend = config.onEnd;
    if (config.onError) utterance.onerror = (e) => {
      console.error("TTS Error:", e);
      config.onError!(e);
    };
    
    synth.speak(utterance);
  }

  cancel() {
    if (typeof window !== 'undefined' && window.speechSynthesis) {
      window.speechSynthesis.cancel();
    }
  }
}

interface ChatMessage {
  id: string;
  sender: string;
  text: string;
}

interface UploadedFile {
  name: string;
  size: number;
  uploadDate: string;
}

export default function App() {
  const [files, setFiles] = useState<File[]>([]);
  const [uploadedFiles, setUploadedFiles] = useState<UploadedFile[]>([]);
  const [message, setMessage] = useState('');
  const [chat, setChat] = useState<ChatMessage[]>([]);
  const [podcastScript, setPodcastScript] = useState<string>('');
  const [analysis, setAnalysis] = useState<string>('');
  const [isGenerating, setIsGenerating] = useState(false);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const isPlayingRef = useRef(false);
  const [currentLineIndex, setCurrentLineIndex] = useState<number | null>(null);
  const [activeTab, setActiveTab] = useState<'analysis' | 'podcast' | 'chat'>('analysis');
  const [isListening, setIsListening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [openaiApiKey, setOpenaiApiKey] = useState('');
  
  const ttsRef = useRef<TTSPlayer | null>(null);
  const bgAudioRef = useRef<HTMLAudioElement | null>(null);
  
  useEffect(() => {
    bgAudioRef.current = new Audio('https://cdn.pixabay.com/download/audio/2022/05/16/audio_182b819207.mp3?filename=lofi-study-112191.mp3');
    bgAudioRef.current.loop = true;
    bgAudioRef.current.volume = 0.05;
    return () => {
      if (bgAudioRef.current) {
        bgAudioRef.current.pause();
      }
    };
  }, []);

  useEffect(() => {
    if (isPlaying && bgAudioRef.current) {
      bgAudioRef.current.play().catch(e => console.log("Audio play failed", e));
    } else if (!isPlaying && bgAudioRef.current) {
      bgAudioRef.current.pause();
    }
  }, [isPlaying]);

  const getTTS = () => {
    if (!ttsRef.current) {
      ttsRef.current = new TTSPlayer();
    }
    return ttsRef.current;
  };
  const recognitionRef = useRef<any>(null);

  useEffect(() => {
    // Initialize Speech Recognition
    const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (SpeechRecognition) {
      recognitionRef.current = new SpeechRecognition();
      recognitionRef.current.continuous = false;
      recognitionRef.current.interimResults = false;
      recognitionRef.current.lang = 'en-US';

      recognitionRef.current.onresult = (event: any) => {
        const transcript = event.results[0][0].transcript;
        setMessage(prev => prev + (prev ? ' ' : '') + transcript);
        setIsListening(false);
      };

      recognitionRef.current.onerror = (event: any) => {
        console.error('Speech recognition error', event.error);
        setIsListening(false);
      };

      recognitionRef.current.onend = () => {
        setIsListening(false);
      };
    }
  }, []);

  useEffect(() => {
    if (currentLineIndex !== null) {
      const element = document.getElementById(`line-${currentLineIndex}`);
      if (element) {
        element.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    }
  }, [currentLineIndex]);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) {
      setFiles(Array.from(e.target.files));
    }
  };

  const uploadFiles = async () => {
    if (files.length === 0) return;
    setIsAnalyzing(true);
    setError(null);
    
    try {
      const data = await uploadPDF(files[0]); // Simplified to upload one file
      setUploadedFiles(data.files);
      await runAnalysis();
    } catch (err) {
      console.error(err);
      setError(err instanceof Error ? err.message : "Failed to process PDF files");
    } finally {
      setIsAnalyzing(false);
    }
  };

  const runAnalysis = async () => {
    setIsAnalyzing(true);
    setError(null);
    try {
      const analysisData = await generateEpisode('default', "Analyze this magazine source. Identify all editorial articles, advertisers, advertorials, and features. Provide a structured summary of each.");
      setAnalysis(analysisData.reply || 'Analysis failed.');
      setActiveTab('analysis');
    } catch (err) {
      console.error(err);
      setError(err instanceof Error ? err.message : "Failed to analyze content");
    } finally {
      setIsAnalyzing(false);
    }
  };

  const formatSize = (bytes: number) => {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
  };

  const formatDate = (dateStr: string) => {
    return new Date(dateStr).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };

  const clearFiles = async () => {
    await fetch("/api/clear", { method: "POST" });
    setFiles([]);
    setUploadedFiles([]);
    setPodcastScript('');
    setAnalysis('');
    setChat([]);
  };

  const generateDeepDive = async () => {
    if (uploadedFiles.length === 0) return;
    setIsGenerating(true);
    setError(null);
    setActiveTab('podcast');
    setPodcastScript('');
    setCurrentLineIndex(null);
    setIsPlaying(false);
    getTTS().cancel();

    try {
      const response = await fetch("/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ 
          message: "Generate a detailed DeepDive podcast episode. Analyze all articles, promote the advertisers, and discuss the editorial content of these magazines in depth.",
          stream: true
        })
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error || `Server error: ${response.status}`);
      }

      if (!response.body) throw new Error("No response body");
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let fullText = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        
        const chunk = decoder.decode(value);
        const lines = chunk.split('\n');
        
        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = line.slice(6);
            if (data === '[DONE]') break;
            
            let parsed;
            try {
              parsed = JSON.parse(data);
            } catch (e) {
              continue;
            }
            
            if (parsed.error) {
              throw new Error(parsed.error);
            }
            if (parsed.text) {
              fullText += parsed.text;
              setPodcastScript(fullText);
            }
          }
        }
      }
    } catch (err) {
      console.error(err);
      setError(err instanceof Error ? err.message : "Error generating DeepDive.");
      setPodcastScript('Generation failed. Please check the error message.');
    } finally {
      setIsGenerating(false);
    }
  };

  const sendMessage = async () => {
    if (!message) return;
    
    const userMsgId = Math.random().toString(36).substring(7);
    const aiMsgId = Math.random().toString(36).substring(7);
    
    const userMsg = { id: userMsgId, sender: 'You', text: message };
    setChat(prev => [...prev, userMsg]);
    setMessage('');
    setError(null);
    
    setChat(prev => [...prev, { id: aiMsgId, sender: 'AI', text: '' }]);

    try {
      const response = await fetch("/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message, stream: true })
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error || `Server error: ${response.status}`);
      }

      if (!response.body) throw new Error("No response body");
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let fullText = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        
        const chunk = decoder.decode(value);
        const lines = chunk.split('\n');
        
        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = line.slice(6);
            if (data === '[DONE]') break;
            
            let parsed;
            try {
              parsed = JSON.parse(data);
            } catch (e) {
              continue;
            }
            
            if (parsed.error) {
              throw new Error(parsed.error);
            }
            if (parsed.text) {
              fullText += parsed.text;
              setChat(prev => prev.map(msg => 
                msg.id === aiMsgId ? { ...msg, text: fullText } : msg
              ));
            }
          }
        }
      }
      
      // Speak the AI reply
      const tts = getTTS();
      tts.cancel();
      
      const CHAT_SPEECH_DELAY_MS = 200; // Configurable delay before speaking
      
      setTimeout(() => {
        // If it's a dialogue, speak it like a podcast
        if (fullText.includes('Thandi:') || fullText.includes('Njabulo:')) {
          const lines = fullText.split('\n').filter(l => l.trim());
          let lineIdx = 0;
          const speakNext = () => {
            if (lineIdx >= lines.length) return;
            const line = lines[lineIdx];
            let speakerText = line;
            let pitch = 1.0;
            let rate = 1.0;

            if (line.startsWith('Thandi:')) {
              speakerText = line.replace('Thandi:', '').trim();
              pitch = 1.2;
            } else if (line.startsWith('Njabulo:')) {
              speakerText = line.replace('Njabulo:', '').trim();
              pitch = 0.8;
              rate = 0.9;
            }

            tts.speak(speakerText, {
              pitch,
              rate,
              onEnd: () => {
                lineIdx++;
                setTimeout(speakNext, 200);
              }
            });
          };
          speakNext();
        } else {
          tts.speak(fullText, { pitch: 1.2, rate: 1.0 });
        }
      }, CHAT_SPEECH_DELAY_MS);

    } catch (err) {
      console.error(err);
      setChat(prev => [...prev, { id: 'error-' + Date.now(), sender: 'System', text: 'Error communicating with server.' }]);
    }
  };

  const podcastLines = useMemo(() => {
    return podcastScript.split('\n').filter(l => l.trim());
  }, [podcastScript]);

  const playPodcast = (startIndex = 0) => {
    if (podcastLines.length === 0) return;
    
    const tts = getTTS();
    tts.cancel();
    setIsPlaying(true);
    isPlayingRef.current = true;
    
    let index = startIndex;

    const speakNext = () => {
      if (index >= podcastLines.length || !isPlayingRef.current) {
        setIsPlaying(false);
        isPlayingRef.current = false;
        setCurrentLineIndex(null);
        return;
      }

      setCurrentLineIndex(index);
      const line = podcastLines[index];
      
      let text = line;
      let pitch = 1.0;
      let rate = 1.0;

      if (line.startsWith('Thandi:')) {
        text = line.replace('Thandi:', '').trim();
        pitch = 1.2;
      } else if (line.startsWith('Njabulo:')) {
        text = line.replace('Njabulo:', '').trim();
        pitch = 0.8;
        rate = 0.9;
      }

      tts.speak(text, {
        pitch,
        rate,
        onEnd: () => {
          index++;
          setTimeout(speakNext, 220);
        },
        onError: (e) => {
          console.error("Playback failed:", e);
          setError("Audio playback failed. Your browser might be blocking text-to-speech, or your device is on silent.");
          setIsPlaying(false);
          isPlayingRef.current = false;
          setCurrentLineIndex(null);
        }
      });
    };

    speakNext();
  };

  const seekPodcast = (newIndex: number) => {
    if (newIndex < 0) newIndex = 0;
    if (newIndex >= podcastLines.length) newIndex = podcastLines.length - 1;
    
    if (isPlaying) {
      playPodcast(newIndex);
    } else {
      setCurrentLineIndex(newIndex);
    }
  };

  const jumpForward = () => {
    if (currentLineIndex !== null) {
      seekPodcast(currentLineIndex + 2);
    } else {
      seekPodcast(2);
    }
  };

  const jumpBackward = () => {
    if (currentLineIndex !== null) {
      seekPodcast(currentLineIndex - 2);
    }
  };

  const stopPodcast = () => {
    getTTS().cancel();
    setIsPlaying(false);
    isPlayingRef.current = false;
    setCurrentLineIndex(null);
  };

  const copyScript = () => {
    navigator.clipboard.writeText(podcastScript);
  };

  const downloadAnalysis = () => {
    const blob = new Blob([analysis], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'HarvestCast_Analysis.md';
    a.click();
    URL.revokeObjectURL(url);
  };

  const toggleListening = () => {
    if (isListening) {
      recognitionRef.current?.stop();
    } else {
      recognitionRef.current?.start();
      setIsListening(true);
    }
  };

  return (
    <div className="app min-h-screen flex flex-col md:flex-row bg-ink text-paper overflow-hidden">
      <div className="grain-overlay" />
      
      {/* ── ERROR BANNER ── */}
      {error && (
        <div className="fixed top-4 left-1/2 -translate-x-1/2 z-50 animate-in slide-in-from-top-4 fade-in duration-300 w-full max-w-lg px-4">
          <div className="bg-rust/95 backdrop-blur-md text-paper px-4 py-3 rounded-2xl shadow-2xl border border-rust/50 flex items-start gap-3">
            <AlertCircle className="w-5 h-5 shrink-0 mt-0.5 text-paper/90" />
            <div className="flex-1 min-w-0">
              <h3 className="font-bold text-sm">Error</h3>
              <p className="text-xs opacity-90 break-words">{error}</p>
            </div>
            <button 
              onClick={() => setError(null)}
              className="p-1.5 hover:bg-white/10 rounded-full transition-colors shrink-0"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}

      {/* ── SIDEBAR ── */}
      <aside className="w-full md:w-80 bg-paper/5 border-r border-amber-500/20 flex flex-col h-screen overflow-y-auto p-6 space-y-8 z-10">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 bg-amber-500 rounded-full flex items-center justify-center shadow-lg">
            <span className="text-xl">🌾</span>
          </div>
          <div>
            <h1 className="editorial-title text-2xl text-amber-500 leading-none">HarvestCast</h1>
            <p className="font-mono text-[8px] uppercase tracking-[0.2em] text-muted mt-1">NotebookLM for Agriculture</p>
          </div>
        </div>

        <div className="space-y-4">
          <h2 className="font-mono text-[10px] uppercase tracking-widest text-muted font-bold">Sources</h2>
          
          <div className="space-y-3">
            {uploadedFiles.map((file, i) => (
              <div key={i} className="bg-ink/40 p-3 rounded-xl border border-amber-500/10 flex items-center gap-3 group">
                <FileText className="w-4 h-4 text-amber-500 shrink-0" />
                <div className="flex flex-col min-w-0">
                  <span className="text-xs font-bold truncate">{file.name}</span>
                  <span className="text-[9px] text-muted uppercase tracking-tighter">{formatSize(file.size)}</span>
                </div>
              </div>
            ))}

            <div className="pt-2">
              <input 
                type="file" 
                multiple 
                accept=".pdf" 
                onChange={handleFileChange}
                className="hidden" 
                id="file-upload"
              />
              <label 
                htmlFor="file-upload"
                className="w-full flex items-center justify-center gap-2 py-3 border-2 border-dashed border-amber-500/20 rounded-xl text-xs font-bold text-amber-500/60 hover:border-amber-500/40 hover:text-amber-500 transition-all cursor-pointer"
              >
                <Upload className="w-4 h-4" />
                <span>Add Source</span>
              </label>
            </div>

            {files.length > 0 && (
              <button 
                onClick={uploadFiles}
                disabled={isAnalyzing}
                className="w-full btn-amber py-3 rounded-xl text-xs font-black uppercase tracking-widest shadow-lg flex items-center justify-center gap-2"
              >
                {isAnalyzing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
                Analyse {files.length} {files.length === 1 ? 'Source' : 'Sources'}
              </button>
            )}

            {uploadedFiles.length > 0 && (
              <button 
                onClick={clearFiles}
                className="w-full py-2 text-[9px] uppercase tracking-widest text-rust/60 hover:text-rust transition-colors font-bold"
              >
                Clear All Sources
              </button>
            )}
          </div>
        </div>

        <div className="pt-8 space-y-4">
          <h2 className="font-mono text-[10px] uppercase tracking-widest text-muted font-bold">Navigation</h2>
          <nav className="flex flex-col gap-2">
            {(['analysis', 'podcast', 'chat'] as const).map((tab) => (
              <button
                key={tab}
                onClick={() => setActiveTab(tab)}
                className={`flex items-center gap-3 px-4 py-3 rounded-xl text-xs font-bold uppercase tracking-widest transition-all ${
                  activeTab === tab 
                    ? 'bg-amber-500 text-ink shadow-lg' 
                    : 'text-paper/60 hover:text-paper hover:bg-paper/5'
                }`}
              >
                {tab === 'analysis' && <FileText className="w-4 h-4" />}
                {tab === 'podcast' && <Mic className="w-4 h-4" />}
                {tab === 'chat' && <MessageSquare className="w-4 h-4" />}
                {tab}
              </button>
            ))}
          </nav>
        </div>
      </aside>

      {/* ── MAIN CONTENT ── */}
      <main className="flex-1 flex flex-col h-screen overflow-hidden relative">
        <header className="p-6 border-b border-amber-500/10 flex justify-between items-center bg-ink/50 backdrop-blur-md z-20">
          <div className="flex items-center gap-4">
            <h2 className="editorial-title text-2xl capitalize">{activeTab}</h2>
            {isPlaying && (
              <div className="flex items-center gap-2 px-3 py-1 bg-rust/20 border border-rust/40 rounded-full">
                <div className="w-2 h-2 bg-rust rounded-full animate-pulse" />
                <span className="text-[9px] font-black uppercase tracking-widest text-rust">On Air</span>
              </div>
            )}
          </div>
          
          <div className="flex items-center gap-4">
            <button onClick={() => setShowSettings(true)} className="p-2 text-muted hover:text-amber-500 transition-colors">
              <SettingsIcon className="w-5 h-5" />
            </button>
            {uploadedFiles.length > 0 && activeTab !== 'podcast' && (
              <button 
                onClick={generateDeepDive}
                disabled={isGenerating}
                className="btn-amber px-6 py-2 rounded-full text-[10px] font-black uppercase tracking-widest shadow-xl flex items-center gap-2"
              >
                {isGenerating ? <Loader2 className="w-3 h-3 animate-spin" /> : <Mic className="w-3 h-3" />}
                Generate Deep Dive
              </button>
            )}
          </div>
        </header>

        {showSettings && (
          <div className="fixed inset-0 bg-ink/80 backdrop-blur-sm z-50 flex items-center justify-center p-6">
            <div className="bg-ink border border-amber-500/20 p-8 rounded-3xl w-full max-w-lg shadow-2xl">
              <h2 className="editorial-title text-2xl text-amber-500 mb-6">Settings</h2>
              <div className="space-y-4">
                <label className="block text-xs font-bold uppercase tracking-widest text-muted">OpenAI API Key</label>
                <input 
                  type="password" 
                  value={openaiApiKey}
                  onChange={(e) => setOpenaiApiKey(e.target.value)}
                  className="w-full bg-paper/5 border border-amber-500/20 rounded-xl p-3 text-sm text-paper"
                  placeholder="sk-..."
                />
              </div>
              <div className="mt-8 flex justify-end gap-4">
                <button onClick={() => setShowSettings(false)} className="px-6 py-2 rounded-full text-xs font-bold text-muted hover:text-paper">Close</button>
              </div>
            </div>
          </div>
        )}

        <div className="flex-1 overflow-y-auto p-6 md:p-12 custom-scrollbar">
          {activeTab === 'analysis' && (
            <div className="max-w-4xl mx-auto space-y-8 animate-in fade-in slide-in-from-bottom-4">
              {isAnalyzing ? (
                <div className="flex flex-col items-center justify-center py-32 space-y-6">
                  <Loader2 className="w-12 h-12 text-amber-500 animate-spin" />
                  <p className="editorial-title text-2xl italic">Analyzing magazine content...</p>
                </div>
              ) : !analysis ? (
                <div className="text-center py-32 space-y-6 opacity-30">
                  <FileText className="w-20 h-20 mx-auto" />
                  <p className="editorial-title text-2xl">No Analysis Yet</p>
                  <p className="text-xs font-mono uppercase tracking-widest">Upload a PDF to begin the deep dive</p>
                </div>
              ) : (
                <div className="card-editorial p-8 md:p-12 rounded-3xl border-amber-500/20 bg-paper/5 relative group">
                  <div className="absolute top-6 right-6 flex gap-2 opacity-0 group-hover:opacity-100 transition-all">
                    <button 
                      onClick={runAnalysis}
                      disabled={isAnalyzing}
                      className="p-3 bg-paper/10 text-amber-500 rounded-full shadow-xl hover:bg-paper/20 transition-all"
                      title="Regenerate Analysis"
                    >
                      <Play className="w-4 h-4 rotate-90" />
                    </button>
                    <button 
                      onClick={downloadAnalysis}
                      className="p-3 bg-amber-500 text-ink rounded-full shadow-xl hover:scale-110 transition-all"
                      title="Download Analysis"
                    >
                      <Upload className="w-4 h-4 rotate-180" />
                    </button>
                  </div>
                  <div className="prose prose-invert max-w-none prose-amber">
                    <div className="markdown-body font-serif text-lg leading-relaxed text-paper/90">
                      <Markdown>{analysis}</Markdown>
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}

          {activeTab === 'podcast' && (
            <div className="max-w-4xl mx-auto space-y-8 animate-in fade-in slide-in-from-bottom-4">
              <div className="card-editorial rounded-3xl overflow-hidden border-amber-500/30 shadow-2xl">
                <div className="bg-ink/80 p-6 flex justify-between items-center border-b border-amber-500/10">
                  <div className="flex items-center gap-4">
                    <div className={`w-3 h-3 rounded-full ${isPlaying ? 'bg-rust animate-pulse shadow-[0_0_12px_rgba(184,76,42,0.8)]' : 'bg-muted'}`} />
                    <span className="font-mono text-[10px] uppercase tracking-[0.3em] font-black">
                      {isPlaying ? 'Live Broadcast' : 'Studio Standby'}
                    </span>
                  </div>
                  <div className="flex gap-3">
                    <button 
                      onClick={copyScript}
                      disabled={!podcastScript}
                      className="p-2 text-muted hover:text-amber-500 transition-colors disabled:opacity-30"
                      title="Copy Script"
                    >
                      <FileText className="w-4 h-4" />
                    </button>
                    {!isPlaying ? (
                      <button 
                        onClick={() => playPodcast(0)}
                        disabled={!podcastScript || isGenerating}
                        className="btn-amber px-6 py-2 rounded-full text-[10px] uppercase tracking-widest flex items-center gap-2 disabled:opacity-50"
                      >
                        <Play className="w-3 h-3 fill-current" /> Start Feed
                      </button>
                    ) : (
                      <button 
                        onClick={stopPodcast}
                        className="bg-rust text-paper px-6 py-2 rounded-full text-[10px] uppercase tracking-widest flex items-center gap-2"
                      >
                        <Square className="w-3 h-3 fill-current" /> Cut Feed
                      </button>
                    )}
                  </div>
                </div>

                {podcastScript && podcastLines.length > 0 && (
                  <div className="bg-ink/60 p-4 border-b border-amber-500/10 flex flex-col gap-2">
                    <div className="flex items-center gap-4">
                      <button onClick={jumpBackward} className="p-2 text-muted hover:text-amber-500 transition-colors" title="Jump Backward">
                        <Rewind className="w-4 h-4" />
                      </button>
                      <input 
                        type="range" 
                        min="0" 
                        max={podcastLines.length - 1} 
                        value={currentLineIndex || 0} 
                        onChange={(e) => seekPodcast(parseInt(e.target.value))}
                        className="flex-1 h-2 bg-paper/10 rounded-lg appearance-none cursor-pointer accent-amber-500"
                      />
                      <button onClick={jumpForward} className="p-2 text-muted hover:text-amber-500 transition-colors" title="Jump Forward">
                        <FastForward className="w-4 h-4" />
                      </button>
                    </div>
                    <div className="flex justify-between text-[10px] font-mono text-muted px-10">
                      <span>Line {currentLineIndex !== null ? currentLineIndex + 1 : 0}</span>
                      <span>{podcastLines.length} Lines</span>
                    </div>
                  </div>
                )}

                {isPlaying && currentLineIndex !== null && (
                  <div className="bg-amber-500/10 border-b border-amber-500/20 p-4 flex justify-between items-center animate-in slide-in-from-top-4">
                    <div className="flex items-center gap-3">
                      <Volume2 className="w-5 h-5 text-amber-500 animate-bounce" />
                      <span className="text-[11px] font-mono uppercase tracking-widest text-amber-500 font-black">
                        Speaking: {podcastLines[currentLineIndex]?.split(':')[0]}
                      </span>
                    </div>
                    <button 
                      onClick={() => setActiveTab('chat')}
                      className="px-4 py-1.5 bg-amber-500 text-ink rounded-full text-[10px] font-black uppercase tracking-widest hover:bg-amber-400 transition-all shadow-lg flex items-center gap-2"
                    >
                      <MessageSquare className="w-3 h-3" /> Join Conversation
                    </button>
                  </div>
                )}

                <div className="p-8 md:p-12 bg-paper/5 backdrop-blur-sm max-h-[65vh] overflow-y-auto space-y-8 scroll-smooth">
                  {isGenerating ? (
                    <div className="flex flex-col items-center justify-center py-20 space-y-8">
                      <div className="relative">
                        <div className="w-24 h-24 border-4 border-amber-500/20 border-t-amber-500 rounded-full animate-spin" />
                        <Mic className="w-8 h-8 text-amber-500 absolute inset-0 m-auto animate-pulse" />
                      </div>
                      <div className="text-center space-y-2">
                        <p className="editorial-title text-2xl italic">Thandi & Njabulo are scripting...</p>
                        <p className="font-mono text-[10px] uppercase tracking-[0.3em] text-muted">Analyzing every article and advertiser</p>
                      </div>
                    </div>
                  ) : !podcastScript ? (
                    <div className="flex flex-col items-center justify-center py-32 opacity-20 text-center">
                      <Mic className="w-20 h-20 mb-6" />
                      <p className="editorial-title text-2xl">Studio is Silent</p>
                      <p className="font-mono text-[10px] uppercase tracking-widest mt-2">Generate a Deep Dive to hear the hosts</p>
                    </div>
                  ) : (
                    <div className="space-y-6">
                      {podcastLines.map((line, i) => {
                        const isThandi = line.startsWith('Thandi:');
                        const isNjabulo = line.startsWith('Njabulo:');
                        const isActive = currentLineIndex === i;
                        
                        return (
                          <div 
                            key={i} 
                            id={`line-${i}`}
                            className={`p-6 rounded-2xl transition-all duration-500 border ${
                              isActive 
                                ? 'bg-amber-500/10 border-amber-500/50 shadow-2xl scale-[1.02] z-10' 
                                : 'bg-ink/20 border-transparent opacity-40 hover:opacity-80'
                            }`}
                          >
                            <span className={`font-mono text-[10px] uppercase tracking-widest font-black mb-2 block ${isThandi ? 'text-amber-500' : isNjabulo ? 'text-teal-500' : 'text-muted'}`}>
                              {line.split(':')[0]}
                            </span>
                            <p className="text-lg md:text-xl font-serif leading-relaxed italic text-paper/90">
                              {line.split(':').slice(1).join(':').trim()}
                            </p>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}

          {activeTab === 'chat' && (
            <div className="max-w-3xl mx-auto flex flex-col h-full">
              <div className="flex-1 overflow-y-auto space-y-6 mb-8 pr-4 custom-scrollbar">
                {chat.length === 0 && (
                  <div className="text-center py-32 space-y-6">
                    <div className="w-24 h-24 bg-paper/5 rounded-full flex items-center justify-center mx-auto border border-amber-500/20">
                      <MessageSquare className="w-10 h-10 text-amber-500/40" />
                    </div>
                    <div className="space-y-2">
                      <h2 className="editorial-title text-3xl">Join the Conversation</h2>
                      <p className="text-muted font-medium">Ask Thandi and Njabulo anything about the magazine content.</p>
                    </div>
                  </div>
                )}
                {chat.map((msg) => (
                  <div key={msg.id} className={`flex ${msg.sender === 'You' ? 'justify-end' : 'justify-start'} animate-in fade-in slide-in-from-bottom-2 duration-300`}>
                    <div className={`max-w-[85%] shadow-2xl rounded-2xl px-6 py-4 ${msg.sender === 'You' ? 'bg-amber-500 text-ink' : 'bg-paper/10 border border-amber-500/20 text-paper'}`}>
                      <p className="font-mono text-[9px] uppercase tracking-widest font-black mb-2 opacity-60">
                        {msg.sender === 'You' ? 'Listener' : 'Studio Host'}
                      </p>
                      <p className="text-sm md:text-base leading-relaxed font-medium">{msg.text}</p>
                    </div>
                  </div>
                ))}
              </div>
              
              <div className="pb-8">
                <div className="relative group">
                  <div className="absolute -inset-1 bg-gradient-to-r from-amber-500 to-teal-500 rounded-3xl blur opacity-20 group-hover:opacity-40 transition duration-1000"></div>
                  <div className="relative flex gap-3 bg-ink/80 p-3 rounded-2xl shadow-2xl border border-amber-500/20 backdrop-blur-xl">
                    <input 
                      className="flex-1 px-6 py-4 outline-none text-paper font-medium placeholder:text-muted/50 bg-transparent"
                      type="text" 
                      value={message}
                      onChange={(e) => setMessage(e.target.value)}
                      onKeyDown={(e) => e.key === 'Enter' && sendMessage()}
                      placeholder="Ask the hosts..." 
                    />
                    <button 
                      onClick={toggleListening}
                      className={`p-4 rounded-xl transition-all ${isListening ? 'bg-rust text-paper animate-pulse scale-110' : 'bg-paper/5 text-muted hover:bg-paper/10'}`}
                      title={isListening ? 'Stop Listening' : 'Voice Input'}
                    >
                      {isListening ? <MicOff className="w-6 h-6" /> : <Mic className="w-6 h-6" />}
                    </button>
                    <button 
                      onClick={sendMessage}
                      className="btn-amber px-8 py-4 rounded-xl shadow-lg flex items-center gap-2 group/btn"
                    >
                      <span className="uppercase tracking-widest text-xs font-black">Send</span>
                      <Play className="w-3 h-3 fill-current group-hover:translate-x-1 transition-transform" />
                    </button>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      </main>
      
      {/* ── FOOTER ── */}
      <footer className="fixed bottom-4 right-4 z-30 flex items-center gap-4 bg-ink/80 backdrop-blur-md border border-amber-500/20 px-6 py-3 rounded-2xl shadow-2xl">
        <div className="flex items-center gap-2">
          <div className="w-2 h-2 bg-amber-500 rounded-full animate-pulse" />
          <span className="font-mono text-[9px] uppercase tracking-widest text-amber-500 font-bold">System Online</span>
        </div>
        <div className="h-4 w-px bg-amber-500/20" />
        <div className="flex items-center gap-2">
          <HardDrive className="w-3 h-3 text-muted" />
          <span className="font-mono text-[9px] uppercase tracking-widest text-muted font-bold">Storage: {formatSize(uploadedFiles.reduce((acc, f) => acc + f.size, 0))}</span>
        </div>
      </footer>
    </div>
  );
}

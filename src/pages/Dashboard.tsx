import { Bot, LogOut, Plus, MessageSquare, Copy, Trash2, Globe, CheckCircle, Clock, XCircle, Zap, Check } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext'
import { useEffect, useMemo, useRef, useState } from 'react'
import { createChatbot, deleteChatbot, listChatbots, scrapeWebsite, listKnowledgeSources, streamProvisioningEvents, updateChatbot, type Chatbot, type KnowledgeSource } from '../lib/api'

const SCRAPING_BOTS_STORAGE_KEY = 'idpa_scraping_bots'

function loadScrapingBotsFromStorage(): Set<string> {
  try {
    const raw = localStorage.getItem(SCRAPING_BOTS_STORAGE_KEY)
    if (!raw) return new Set()
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return new Set()
    return new Set(parsed.filter((v): v is string => typeof v === 'string' && v.length > 0))
  } catch {
    return new Set()
  }
}

export default function Dashboard() {
  const navigate = useNavigate()
  const { user, signOut } = useAuth()

  const handleSignOut = async () => {
    await signOut()
    navigate('/')
  }

  const [chatbots, setChatbots] = useState<Chatbot[]>([])
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)

  // Erstellungs-Workflow
  const [showCreateModal, setShowCreateModal] = useState(false)
  const [step, setStep] = useState<'details' | 'scraping' | 'done'>('details')
  const [name, setName] = useState('')
  const [systemPrompt, setSystemPrompt] = useState('')
  const [websiteUrl, setWebsiteUrl] = useState('')
  const [creating, setCreating] = useState(false)
  const [newChatbot, setNewChatbot] = useState<Chatbot | null>(null)

  // Bot Details
  const [selectedBot, setSelectedBot] = useState<Chatbot | null>(null)
  const [botSources, setBotSources] = useState<KnowledgeSource[]>([])
  const [loadingSources, setLoadingSources] = useState(false)
  const [activeTab, setActiveTab] = useState<'details' | 'settings' | 'preview'>('details')
  const [drawerOpen, setDrawerOpen] = useState(false)

  // Formular-State
  const [editName, setEditName] = useState('')
  const [editDescription, setEditDescription] = useState('')
  const [editSystemPrompt, setEditSystemPrompt] = useState('')
  const [editLogoUrl, setEditLogoUrl] = useState('')
  const [editPrimaryColor, setEditPrimaryColor] = useState('#4F46E5')
  const [editAvatarType, setEditAvatarType] = useState<'robot' | 'human' | 'pencil'>('robot')
  const [saving, setSaving] = useState(false)

  // Hintergrund-Scraping
  const [scrapingBots, setScrapingBots] = useState<Set<string>>(() => loadScrapingBotsFromStorage())
  const provisioningAbortControllersRef = useRef<Map<string, AbortController>>(new Map())

  // Widget Vorschau
  const [widgetGreeting, setWidgetGreeting] = useState('Hallo! Wie können wir dir helfen?')
  const [widgetPreviewNonce, setWidgetPreviewNonce] = useState(0)
  const [copied, setCopied] = useState(false)

  const isBotPreparing = (bot: Chatbot) => {
    const hasPendingSources = selectedBot?.id === bot.id && botSources.some((s) => s.status === 'PENDING')
    return scrapingBots.has(bot.id) || hasPendingSources
  }

  const embedBase = useMemo(() => window.location.origin, [])
  const snippet = useMemo(() => {
    if (!selectedBot || selectedBot.status !== 'ACTIVE') return ''
    const cfg = `window.ChatBotConfig = {\n  chatbotId: "${selectedBot.id}",\n  baseUrl: "${embedBase}"\n}`
    const src = `${embedBase}/embed.js`
    return `<script>\n${cfg}\n</script>\n<script defer src="${src}"></script>`
  }, [selectedBot, embedBase])

  const widgetPreviewUrl = useMemo(() => {
    if (!selectedBot) return ''
    const base = `${window.location.origin}/widget`
    const params = new URLSearchParams({
      chatbotId: selectedBot.id,
      primaryColor: editPrimaryColor,
      title: editName || selectedBot.name,
      greeting: widgetGreeting,
      avatar: editAvatarType,
      v: String(widgetPreviewNonce),
    })
    return `${base}?${params.toString()}`
  }, [editAvatarType, editName, editPrimaryColor, selectedBot, widgetGreeting, widgetPreviewNonce])

  const load = async ({ silent }: { silent?: boolean } = {}) => {
    if (!silent) setError(null)
    try {
      const data = await listChatbots()
      setChatbots(data)
      setSelectedBot((prev) => {
        if (!prev) return prev
        return data.find((b) => b.id === prev.id) ?? prev
      })

      setScrapingBots((prev) => {
        if (!prev.size) return prev
        const updated = new Set(prev)
        for (const id of prev) {
          const bot = data.find((b) => b.id === id)
          if (bot?.status === 'ACTIVE') {
            updated.delete(id)
          }
        }
        return updated
      })
    } catch (e) {
      if (!silent) {
        setError(e instanceof Error ? e.message : 'Unbekannter Fehler')
      } else {
        console.error('Fehler beim Hintergrund-Refresh:', e)
      }
    }
  }

  useEffect(() => {
    load()
  }, [])

  useEffect(() => {
    localStorage.setItem(SCRAPING_BOTS_STORAGE_KEY, JSON.stringify(Array.from(scrapingBots)))
  }, [scrapingBots])

  useEffect(() => {
    const controllers = provisioningAbortControllersRef.current
    return () => {
      for (const controller of controllers.values()) {
        controller.abort()
      }
      controllers.clear()
    }
  }, [])

  const loadBotSources = async (chatbotId: string) => {
    setLoadingSources(true)
    try {
      const sources = await listKnowledgeSources(chatbotId)
      setBotSources(sources)
      const hasPending = sources.some((s) => s.status === 'PENDING')
      if (!hasPending) {
        setScrapingBots((prev) => {
          const updated = new Set(prev)
          updated.delete(chatbotId)
          return updated
        })
      }
    } catch (e) {
      console.error('Fehler beim Laden der Quellen:', e)
    } finally {
      setLoadingSources(false)
    }
  }

  useEffect(() => {
    if (selectedBot) {
      loadBotSources(selectedBot.id)
      setActiveTab('details')
      setEditName(selectedBot.name)
      setEditDescription(selectedBot.description || '')
      setEditSystemPrompt(selectedBot.systemPrompt || '')
      setEditLogoUrl(selectedBot.logoUrl || '')
      const theme = selectedBot.theme as { primaryColor?: unknown; avatarType?: unknown } | null | undefined
      setEditPrimaryColor(typeof theme?.primaryColor === 'string' ? theme.primaryColor : '#4F46E5')
      const avatar = theme?.avatarType
      setEditAvatarType(avatar === 'human' ? 'human' : avatar === 'pencil' ? 'pencil' : 'robot')
      setWidgetPreviewNonce((n) => n + 1)

      // Only subscribe to SSE if bot is not yet ACTIVE (still processing)
      // This prevents unnecessary connections for already-active bots
      const needsStatusUpdates = selectedBot.status !== 'ACTIVE'
      let controller: AbortController | null = null

      if (needsStatusUpdates) {
        controller = new AbortController()
        void streamProvisioningEvents({
          chatbotId: selectedBot.id,
          signal: controller.signal,
          onEvent: (evt) => {
            if (evt.chatbotId !== selectedBot.id) return
            // Only reload on actual status changes, NOT on snapshot (which is just initial state)
            if (evt.type === 'completed' || evt.type === 'failed') {
              loadBotSources(selectedBot.id)
              void load({ silent: true })
              // Close the SSE connection after completion
              controller?.abort()
            }
          },
        }).catch((err) => {
          if (err?.name !== 'AbortError') {
            console.error('SSE stream error:', err)
          }
        })
      }

      return () => controller?.abort()
    }
  }, [selectedBot])

  const handleSelectBot = (bot: Chatbot) => {
    setSelectedBot(bot)
    setDrawerOpen(true)
  }

  const handleCreateClick = () => {
    setShowCreateModal(true)
    setStep('details')
    setName('')
    setSystemPrompt('')
    setWebsiteUrl('')
    setNewChatbot(null)
    setError(null)
    setSuccess(null)
  }

  const handleStepOne = async (e: React.FormEvent) => {
    e.preventDefault()
    setCreating(true)
    setError(null)
    try {
      const bot = await createChatbot({
        name,
        systemPrompt: systemPrompt || undefined,
        allowedDomains: [],
        status: 'DRAFT',
      })
      setChatbots((prev) => [bot, ...prev.filter((b) => b.id !== bot.id)])
      setNewChatbot(bot)
      setStep('scraping')
      setSuccess(`Assistent "${bot.name}" erfolgreich angelegt.`) // Corrected: escaped double quote
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unbekannter Fehler')
    } finally {
      setCreating(false)
    }
  }

  const handleScrapeWebsite = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!newChatbot) return

    setShowCreateModal(false)
    setScrapingBots((prev) => new Set(prev).add(newChatbot.id))
    setSelectedBot(newChatbot)
    setDrawerOpen(true)
    setSuccess(`Lernprozess für "${newChatbot.name}" gestartet.`) // Corrected: escaped double quote

    const controller = new AbortController()
    provisioningAbortControllersRef.current.get(newChatbot.id)?.abort()
    provisioningAbortControllersRef.current.set(newChatbot.id, controller)
    void streamProvisioningEvents({
      chatbotId: newChatbot.id,
      signal: controller.signal,
      onEvent: (evt) => {
        if (evt.chatbotId !== newChatbot.id) return
        if (evt.type === 'completed' && evt.status === 'ACTIVE') {
          setScrapingBots((prev) => {
            const updated = new Set(prev)
            updated.delete(newChatbot.id)
            return updated
          })
          provisioningAbortControllersRef.current.get(newChatbot.id)?.abort()
          provisioningAbortControllersRef.current.delete(newChatbot.id)
          void load({ silent: true })
        }
        if (evt.type === 'failed') {
          setScrapingBots((prev) => {
            const updated = new Set(prev)
            updated.delete(newChatbot.id)
            return updated
          })
          provisioningAbortControllersRef.current.get(newChatbot.id)?.abort()
          provisioningAbortControllersRef.current.delete(newChatbot.id)
          setError(`Lernprozess fehlgeschlagen: ${evt.error || 'Unbekannter Fehler'}`)
        }
      },
    }).catch((err) => {
      if (err instanceof Error && err.name === 'AbortError') return
      console.error('Provisioning-Stream Fehler:', err)
    })

    scrapeWebsite({
      chatbotId: newChatbot.id,
      startUrls: [websiteUrl],
      maxDepth: 4,
      maxPages: 200,
    }).catch((e) => {
      setScrapingBots((prev) => {
        const updated = new Set(prev)
        updated.delete(newChatbot.id)
        return updated
      })
      setError(`Lernprozess fehlgeschlagen: ${e instanceof Error ? e.message : 'Unbekannter Fehler'}`)
    })
  }

  const handleSkipScraping = () => {
    setStep('done')
    load()
  }

  const handleFinish = () => {
    setShowCreateModal(false)
    if (newChatbot) {
      setSelectedBot(newChatbot)
      setDrawerOpen(true)
    }
    setNewChatbot(null)
  }

  const onDelete = async (id: string) => {
    if (!confirm('Möchten Sie diesen Assistenten unwiderruflich löschen?')) return
    setError(null)
    try {
      await deleteChatbot(id)
      if (selectedBot?.id === id) setSelectedBot(null)
      await load()
      setSuccess('Assistent gelöscht')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unbekannter Fehler')
    }
  }

  const handleSaveSettings = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!selectedBot) return
    setSaving(true)
    setError(null)
    try {
      const updated = await updateChatbot(selectedBot.id, {
        name: editName,
        description: editDescription || undefined,
        systemPrompt: editSystemPrompt || undefined,
        logoUrl: editLogoUrl || undefined,
        theme: { primaryColor: editPrimaryColor, avatarType: editAvatarType },
      })
      setSelectedBot(updated)
      await load()
      setSuccess('Konfiguration gespeichert.')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Fehler beim Speichern')
    } finally {
      setSaving(false)
    }
  }

  const activeBots = chatbots.filter(b => b.status === 'ACTIVE').length

  return (
    <div className="min-h-screen bg-dark-950 text-white font-sans selection:bg-indigo-500/30">
      {/* Header */}
      <header className="border-b border-white/5 bg-dark-950/80 backdrop-blur-xl sticky top-0 z-30">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-between items-center h-16">
            <div className="flex items-center gap-3">
              <div className="p-1.5 bg-gradient-to-br from-indigo-500 to-cyan-500 rounded-lg shadow-lg shadow-indigo-500/20">
                <Bot className="h-5 w-5 text-white" />
              </div>
              <span className="text-lg font-bold tracking-tight text-white">ChatBot Studio</span>
            </div>
            <div className="flex items-center gap-6">
              <span className="text-sm text-gray-400 font-medium">{user?.name || user?.email || 'Admin'}</span>
              <button
                onClick={handleSignOut}
                className="flex items-center gap-2 text-gray-400 hover:text-white transition-colors text-sm"
              >
                <LogOut className="h-4 w-4" />
                <span>Logout</span>
              </button>
            </div>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-10">
        {/* Welcome Section */}
        <div className="mb-10 flex flex-col md:flex-row md:items-end justify-between gap-4">
          <div>
            <h1 className="text-3xl font-bold text-white tracking-tight">Cockpit</h1>
            <p className="mt-2 text-gray-400">
              Übersicht aller aktiven KI-Assistenten und deren Leistungsdaten.
            </p>
          </div>
          <button
            onClick={handleCreateClick}
            className="flex items-center gap-2 bg-indigo-600 hover:bg-indigo-500 text-white px-5 py-2.5 rounded-lg font-medium transition-all shadow-lg shadow-indigo-500/20"
          >
            <Plus className="h-5 w-5" />
            Neuen Assistenten einrichten
          </button>
        </div>

        {/* Alerts */}
        {error && (
          <div className="mb-6 bg-red-500/10 border border-red-500/20 rounded-lg p-4 flex items-start gap-3">
            <XCircle className="h-5 w-5 text-red-400 flex-shrink-0 mt-0.5" />
            <div className="flex-1">
              <p className="text-sm text-red-200">{error}</p>
            </div>
            <button onClick={() => setError(null)} className="text-red-400 hover:text-red-200">×</button>
          </div>
        )}
        {success && (
          <div className="mb-6 bg-green-500/10 border border-green-500/20 rounded-lg p-4 flex items-start gap-3">
            <CheckCircle className="h-5 w-5 text-green-400 flex-shrink-0 mt-0.5" />
            <div className="flex-1">
              <p className="text-sm text-green-200">{success}</p>
            </div>
            <button onClick={() => setSuccess(null)} className="text-green-400 hover:text-green-200">×</button>
          </div>
        )}

        {/* Stats Cards */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-10">
          <div className="glass-panel p-6 rounded-xl relative overflow-hidden group">
            <div className="absolute top-0 right-0 p-4 opacity-5 group-hover:opacity-10 transition-opacity">
              <MessageSquare className="h-24 w-24 text-white" />
            </div>
            <div className="relative z-10">
              <p className="text-sm font-medium text-gray-400 mb-1">Aktive Assistenten</p>
              <div className="flex items-end gap-2">
                <p className="text-3xl font-bold text-white">{activeBots}</p>
                <div className="h-2 w-2 rounded-full bg-green-500 mb-2 animate-pulse" />
              </div>
            </div>
          </div>
          
          <div className="glass-panel p-6 rounded-xl relative overflow-hidden">
             <div className="absolute top-0 right-0 p-4 opacity-5">
              <Bot className="h-24 w-24 text-white" />
            </div>
            <p className="text-sm font-medium text-gray-400 mb-1">Gesamt erstellt</p>
            <p className="text-3xl font-bold text-white">{chatbots.length}</p>
          </div>

          <div className="glass-panel p-6 rounded-xl relative overflow-hidden">
            <div className="absolute top-0 right-0 p-4 opacity-5">
              <MessageSquare className="h-24 w-24 text-white" />
            </div>
            <p className="text-sm font-medium text-gray-400 mb-1">Konversationen heute</p>
            <p className="text-3xl font-bold text-white">—</p>
          </div>
        </div>

        {/* Chatbots Grid */}
        <h2 className="text-xl font-bold text-white mb-6">Meine Assistenten</h2>
        
        {chatbots.length === 0 ? (
          <div className="glass-panel rounded-xl p-16 text-center border-dashed border-2 border-white/10">
            <div className="w-16 h-16 bg-white/5 rounded-full flex items-center justify-center mx-auto mb-6">
              <Bot className="h-8 w-8 text-gray-400" />
            </div>
            <h3 className="text-lg font-semibold text-white mb-2">Noch kein Assistent konfiguriert</h3>
            <p className="text-gray-400 mb-6 max-w-sm mx-auto">Starten Sie jetzt mit der Automatisierung Ihres Kundensupports.</p>
            <button
              onClick={handleCreateClick}
              className="inline-flex items-center gap-2 bg-indigo-600 hover:bg-indigo-500 text-white px-4 py-2 rounded-lg font-medium transition-colors"
            >
              <Plus className="h-4 w-4" />
              Jetzt einrichten
            </button>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {chatbots.map((bot) => (
              <div
                key={bot.id}
                onClick={() => handleSelectBot(bot)}
                className={`glass-panel rounded-xl p-6 cursor-pointer group hover:border-indigo-500/50 transition-all duration-300 relative overflow-hidden ${selectedBot?.id === bot.id ? 'ring-2 ring-indigo-500 border-transparent' : ''}`}
              >
                {/* Status Indicator */}
                <div className="absolute top-4 right-4">
                  <span className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold border ${isBotPreparing(bot) ? 'bg-indigo-500/10 border-indigo-500/20 text-indigo-400' : bot.status === 'ACTIVE' ? 'bg-green-500/10 border-green-500/20 text-green-400' : 'bg-yellow-500/10 border-yellow-500/20 text-yellow-400'}`}>
                    <span className={`w-1.5 h-1.5 rounded-full ${isBotPreparing(bot) ? 'bg-indigo-400 animate-pulse' : bot.status === 'ACTIVE' ? 'bg-green-400' : 'bg-yellow-400'}`} />
                    {isBotPreparing(bot) ? 'Lernphase' : bot.status === 'ACTIVE' ? 'Bereit' : 'Entwurf'}
                  </span>
                </div>

                <div className="flex items-center gap-4 mb-4">
                  <div className="w-12 h-12 rounded-lg bg-gradient-to-br from-gray-800 to-gray-900 border border-white/10 flex items-center justify-center group-hover:scale-105 transition-transform">
                     {bot.logoUrl ? (
                       <img src={bot.logoUrl} alt="" className="w-8 h-8 object-contain" />
                     ) : (
                       <Bot className="h-6 w-6 text-gray-400" />
                     )}
                  </div>
                  <div>
                    <h3 className="font-semibold text-white group-hover:text-indigo-400 transition-colors">{bot.name}</h3>
                    <div className="flex items-center gap-1 text-xs text-gray-500 mt-1">
                      <Globe className="h-3 w-3" />
                      <span className="truncate max-w-[140px]">{bot.allowedDomains.length > 0 ? bot.allowedDomains[0] : 'Keine Domain'}</span>
                    </div>
                  </div>
                </div>

                {isBotPreparing(bot) && (
                  <div className="mb-4">
                     <div className="flex justify-between text-xs text-indigo-300 mb-1">
                       <span>Wissen wird indexiert...</span>
                       <Zap className="h-3 w-3 animate-pulse" />
                     </div>
                     <div className="h-1 w-full bg-gray-800 rounded-full overflow-hidden">
                       <div className="h-full bg-indigo-500 animate-progress w-2/3" />
                     </div>
                  </div>
                )}
                
                <div className="flex items-center justify-between mt-4 pt-4 border-t border-white/5">
                  <div className="text-xs text-gray-500">
                    Erstellt: {new Date(bot.createdAt).toLocaleDateString('de-DE')}
                  </div>
                  <button
                    onClick={(e) => { e.stopPropagation(); onDelete(bot.id) }}
                    className="p-2 text-gray-500 hover:text-red-400 hover:bg-red-500/10 rounded-lg transition-colors"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </main>

      {/* Drawer */}
      {selectedBot && drawerOpen && (
        <>
          <div 
            className="fixed inset-0 bg-black/60 backdrop-blur-sm z-40 transition-opacity" 
            onClick={() => setDrawerOpen(false)}
          />
          <div className="fixed inset-y-0 right-0 z-50 w-full md:w-[600px] bg-dark-900 border-l border-white/10 shadow-2xl flex flex-col transform transition-transform duration-300">
            {/* Drawer Header */}
            <div className="px-6 py-4 border-b border-white/10 flex items-center justify-between bg-dark-900/50 backdrop-blur">
              <div>
                <h2 className="text-lg font-bold text-white">{selectedBot.name}</h2>
                <div className="flex items-center gap-2 text-xs text-gray-400 mt-0.5">
                  <span className="font-mono">{selectedBot.id}</span>
                  <span className="w-1 h-1 rounded-full bg-gray-600" />
                  <span className={selectedBot.status === 'ACTIVE' ? 'text-green-400' : 'text-yellow-400'}>
                    {selectedBot.status === 'ACTIVE' ? 'Bereit' : 'Lernphase'}
                  </span>
                </div>
              </div>
              <button onClick={() => setDrawerOpen(false)} className="p-2 text-gray-400 hover:text-white rounded-lg hover:bg-white/5">
                <XCircle className="h-6 w-6" />
              </button>
            </div>

            {/* Drawer Tabs */}
            <div className="px-6 pt-4 flex gap-4 border-b border-white/10">
              {(['details', 'preview', 'settings'] as const).map((tab) => (
                <button
                  key={tab}
                  onClick={() => setActiveTab(tab)}
                  className={`pb-3 text-sm font-medium border-b-2 transition-colors ${activeTab === tab ? 'border-indigo-500 text-indigo-400' : 'border-transparent text-gray-400 hover:text-white'}`}
                >
                  {tab === 'details' ? 'Details' : tab === 'preview' ? 'Vorschau' : 'Einstellungen'}
                </button>
              ))}
            </div>

            {/* Drawer Content */}
            <div className="flex-1 overflow-y-auto p-6 space-y-6 custom-scrollbar">
              
              {activeTab === 'details' && (
                <div className="space-y-8 animate-in fade-in slide-in-from-right-4 duration-300">
                  {isBotPreparing(selectedBot) && (
                    <div className="bg-indigo-500/10 border border-indigo-500/20 rounded-xl p-4 flex gap-4">
                      <div className="h-10 w-10 rounded-full bg-indigo-500/20 flex items-center justify-center flex-shrink-0">
                        <Zap className="h-5 w-5 text-indigo-400 animate-pulse" />
                      </div>
                      <div>
                        <h4 className="font-medium text-white">Wissensbasis wird aufgebaut</h4>
                        <p className="text-sm text-indigo-200 mt-1">Das System analysiert Ihre Website. Dies kann einige Minuten dauern.</p>
                      </div>
                    </div>
                  )}

                  {selectedBot.systemPrompt && (
                    <div>
                      <h3 className="text-sm font-medium text-gray-400 uppercase tracking-wider mb-4">System-Prompt</h3>
                      <div className="bg-dark-950 border border-white/10 rounded-xl p-4">
                        <p className="text-sm text-gray-300 whitespace-pre-wrap">{selectedBot.systemPrompt}</p>
                      </div>
                    </div>
                  )}

                  <div>
                    <h3 className="text-sm font-medium text-gray-400 uppercase tracking-wider mb-4">Integration</h3>
                    <div className="bg-dark-950 border border-white/10 rounded-xl overflow-hidden">
                      <div className="flex items-center justify-between px-4 py-2 bg-white/5 border-b border-white/5">
                        <span className="text-xs text-gray-400 font-mono">embed.js</span>
                        <button
                          onClick={() => {
                            navigator.clipboard.writeText(snippet)
                            setCopied(true)
                            setTimeout(() => setCopied(false), 2000)
                          }}
                          className={`text-xs flex items-center gap-1.5 px-2 py-1 rounded-md transition-all duration-200 ${
                            copied
                              ? 'bg-green-500/20 text-green-400'
                              : 'text-indigo-400 hover:text-indigo-300 hover:bg-white/5'
                          }`}
                        >
                          {copied ? (
                            <>
                              <Check className="h-3 w-3" />
                              <span>Kopiert!</span>
                            </>
                          ) : (
                            <>
                              <Copy className="h-3 w-3" />
                              <span>Kopieren</span>
                            </>
                          )}
                        </button>
                      </div>
                      <div className="p-4 overflow-x-auto">
                        <pre className="text-xs font-mono text-gray-300">
                          {snippet || '// Code verfügbar sobald aktiv'}
                        </pre>
                      </div>
                    </div>
                  </div>

                  <div>
                    <h3 className="text-sm font-medium text-gray-400 uppercase tracking-wider mb-4">Datenquellen</h3>
                    {loadingSources ? (
                       <div className="space-y-3">
                         {[1,2,3].map(i => <div key={i} className="h-10 bg-white/5 rounded-lg animate-pulse" />)}
                       </div>
                    ) : botSources.length === 0 ? (
                      <div className="text-center py-8 border border-dashed border-white/10 rounded-xl">
                        <p className="text-gray-500 text-sm">Keine Quellen definiert</p>
                      </div>
                    ) : (
                      <ul className="space-y-2">
                        {botSources.map((source) => (
                          <li key={source.id} className="flex items-center justify-between p-3 rounded-lg bg-white/5 border border-white/5">
                             <div className="flex items-center gap-3 overflow-hidden">
                                {source.status === 'READY' ? <CheckCircle className="h-4 w-4 text-green-400 flex-shrink-0" /> :
                                 source.status === 'FAILED' ? <XCircle className="h-4 w-4 text-red-400 flex-shrink-0" /> :
                                 <Clock className="h-4 w-4 text-yellow-400 flex-shrink-0" />}
                                <span className="text-sm text-gray-200 truncate">{source.label}</span>
                             </div>
                             <span className="text-[10px] bg-white/5 px-2 py-1 rounded text-gray-500">{source.type}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                </div>
              )}

              {activeTab === 'preview' && (
                <div className="space-y-6 animate-in fade-in slide-in-from-right-4 duration-300">
                  <div className="glass-panel p-4 rounded-xl space-y-4">
                    <h3 className="text-sm font-medium text-white">Vorschau Konfiguration</h3>
                    <div className="grid gap-4">
                       <div>
                         <label className="text-xs text-gray-400 block mb-1.5">Begrüßung</label>
                         <input 
                           value={widgetGreeting}
                           onChange={(e) => setWidgetGreeting(e.target.value)}
                           className="w-full bg-dark-950 border border-white/10 rounded-lg px-3 py-2 text-sm text-white focus:ring-1 focus:ring-indigo-500 focus:border-indigo-500 outline-none"
                         />
                       </div>
                    </div>
                    <button 
                       onClick={() => setWidgetPreviewNonce(n => n + 1)}
                       className="w-full py-2 bg-white/5 hover:bg-white/10 border border-white/10 rounded-lg text-xs font-medium text-white transition-colors"
                    >
                      Vorschau neu laden
                    </button>
                  </div>
                  
                  <div className="h-[600px] border border-white/10 rounded-xl overflow-hidden bg-white">
                    <iframe
                      key={widgetPreviewNonce}
                      src={widgetPreviewUrl}
                      title="Widget Preview"
                      className="w-full h-full"
                      allow="microphone"
                    />
                  </div>
                </div>
              )}

              {activeTab === 'settings' && (
                <form onSubmit={handleSaveSettings} className="space-y-6 animate-in fade-in slide-in-from-right-4 duration-300">
                  <div>
                    <label className="block text-sm font-medium text-gray-300 mb-2">Bezeichnung</label>
                    <input
                      type="text"
                      value={editName}
                      onChange={(e) => setEditName(e.target.value)}
                      className="w-full bg-dark-950 border border-white/10 rounded-lg px-4 py-2.5 text-white focus:ring-2 focus:ring-indigo-500/50 outline-none transition-all"
                    />
                  </div>
                  
                  <div>
                    <label className="block text-sm font-medium text-gray-300 mb-2">Beschreibung</label>
                    <textarea
                      value={editDescription}
                      onChange={(e) => setEditDescription(e.target.value)}
                      className="w-full bg-dark-950 border border-white/10 rounded-lg px-4 py-2.5 text-white focus:ring-2 focus:ring-indigo-500/50 outline-none transition-all min-h-[80px]"
                    />
                  </div>

                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="block text-sm font-medium text-gray-300 mb-2">Akzentfarbe</label>
                      <div className="flex gap-2">
                        <input
                          type="color"
                          value={editPrimaryColor}
                          onChange={(e) => setEditPrimaryColor(e.target.value)}
                          className="h-10 w-12 bg-transparent border border-white/10 rounded cursor-pointer"
                        />
                        <input
                           type="text"
                           value={editPrimaryColor}
                           onChange={(e) => setEditPrimaryColor(e.target.value)}
                           className="flex-1 bg-dark-950 border border-white/10 rounded-lg px-3 text-sm text-white"
                        />
                      </div>
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-300 mb-2">Avatar</label>
                       <select 
                         value={editAvatarType}
                         onChange={(e) => setEditAvatarType(e.target.value as any)}
                         className="w-full bg-dark-950 border border-white/10 rounded-lg px-3 py-2.5 text-sm text-white outline-none"
                       >
                         <option value="robot">Roboter</option>
                         <option value="human">Mensch</option>
                         <option value="pencil">Symbol</option>
                       </select>
                    </div>
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-gray-300 mb-2">System-Instruktion</label>
                    <textarea
                      value={editSystemPrompt}
                      onChange={(e) => setEditSystemPrompt(e.target.value)}
                      className="w-full bg-dark-950 border border-white/10 rounded-lg px-4 py-3 text-sm font-mono text-gray-300 focus:ring-2 focus:ring-indigo-500/50 outline-none transition-all min-h-[150px]"
                      placeholder="Sie sind ein hilfreicher Assistent für..."
                    />
                  </div>

                  <div className="pt-4 border-t border-white/10">
                    <button
                      type="submit"
                      disabled={saving}
                      className="w-full bg-indigo-600 hover:bg-indigo-500 text-white font-medium py-3 rounded-lg transition-all shadow-lg shadow-indigo-500/20 disabled:opacity-50"
                    >
                      {saving ? 'Speichert...' : 'Konfiguration speichern'}
                    </button>
                  </div>
                </form>
              )}
            </div>
          </div>
        </>
      )}

      {/* Create Modal */}
      {showCreateModal && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-dark-900 border border-white/10 rounded-2xl shadow-2xl max-w-lg w-full overflow-hidden animate-in zoom-in-95 duration-200">
            <div className="p-6 border-b border-white/10">
              <h2 className="text-xl font-bold text-white">
                {step === 'details' && 'Assistent einrichten'}
                {step === 'scraping' && 'Wissen trainieren'}
                {step === 'done' && 'Einsatzbereit'}
              </h2>
            </div>
            
            <div className="p-6">
              {step === 'details' && (
                <form onSubmit={handleStepOne} className="space-y-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-300 mb-2">
                      Bezeichnung
                    </label>
                    <input
                      type="text"
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      className="w-full bg-dark-950 border border-white/10 rounded-lg px-4 py-3 text-white focus:ring-2 focus:ring-indigo-500/50 outline-none"
                      placeholder="z.B. Support-Bot DE"
                      required
                      autoFocus
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-300 mb-2">
                      System-Prompt <span className="text-gray-500 font-normal">(optional)</span>
                    </label>
                    <textarea
                      value={systemPrompt}
                      onChange={(e) => setSystemPrompt(e.target.value)}
                      className="w-full bg-dark-950 border border-white/10 rounded-lg px-4 py-3 text-white focus:ring-2 focus:ring-indigo-500/50 outline-none min-h-[100px] text-sm"
                      placeholder="z.B. Du bist ein freundlicher Kundenservice-Assistent für..."
                    />
                  </div>
                  <div className="flex gap-3 pt-2">
                    <button
                      type="button"
                      onClick={() => setShowCreateModal(false)}
                      className="flex-1 px-4 py-3 border border-white/10 rounded-lg text-gray-300 hover:bg-white/5 transition-colors"
                    >
                      Abbrechen
                    </button>
                    <button
                      type="submit"
                      disabled={creating}
                      className="flex-1 bg-indigo-600 hover:bg-indigo-500 text-white px-4 py-3 rounded-lg font-medium transition-all shadow-lg shadow-indigo-500/20"
                    >
                      {creating ? 'Wird angelegt...' : 'Weiter'}
                    </button>
                  </div>
                </form>
              )}

              {step === 'scraping' && (
                <form onSubmit={handleScrapeWebsite} className="space-y-6">
                  <div className="bg-indigo-500/10 border border-indigo-500/20 rounded-xl p-4">
                    <p className="text-sm text-indigo-200">
                      Geben Sie Ihre Website-URL ein. Das System erfasst automatisch alle relevanten Unterseiten.
                    </p>
                  </div>
                  
                  <div>
                    <label className="block text-sm font-medium text-gray-300 mb-2">
                      Unternehmens-Website
                    </label>
                    <div className="relative">
                      <Globe className="absolute left-3 top-3.5 h-5 w-5 text-gray-500" />
                      <input
                        type="url"
                        value={websiteUrl}
                        onChange={(e) => setWebsiteUrl(e.target.value)}
                        className="w-full bg-dark-950 border border-white/10 rounded-lg pl-10 pr-4 py-3 text-white focus:ring-2 focus:ring-indigo-500/50 outline-none"
                        placeholder="https://ihre-firma.ch"
                        required
                        autoFocus
                      />
                    </div>
                  </div>

                  <div className="flex gap-3 pt-2">
                    <button
                      type="button"
                      onClick={handleSkipScraping}
                      className="flex-1 px-4 py-3 border border-white/10 rounded-lg text-gray-300 hover:bg-white/5 transition-colors"
                    >
                      Später
                    </button>
                    <button
                      type="submit"
                      className="flex-1 bg-indigo-600 hover:bg-indigo-500 text-white px-4 py-3 rounded-lg font-medium transition-all shadow-lg shadow-indigo-500/20"
                    >
                      Analyse starten
                    </button>
                  </div>
                </form>
              )}

              {step === 'done' && (
                <div className="text-center space-y-6">
                   <div className="w-20 h-20 bg-green-500/20 rounded-full flex items-center justify-center mx-auto">
                     <CheckCircle className="h-10 w-10 text-green-400" />
                   </div>
                   <div>
                     <h3 className="text-xl font-bold text-white mb-2">Basis-Setup abgeschlossen</h3>
                     <p className="text-gray-400">
                       Der Lernprozess läuft im Hintergrund. Sie können bereits weitere Einstellungen vornehmen.
                     </p>
                   </div>
                   <button
                    onClick={handleFinish}
                    className="w-full bg-indigo-600 hover:bg-indigo-500 text-white px-4 py-3 rounded-lg font-medium transition-all shadow-lg shadow-indigo-500/20"
                  >
                    Zum Cockpit
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
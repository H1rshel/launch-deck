import { useState, useRef, useEffect } from 'react'
import { X, Upload, Search, Undo2, Loader, Image as ImageIcon, Gamepad2 } from 'lucide-react'
import { searchWebImages } from '../../lib/rawg'
import { useAuth } from '../../context/AuthContext'
import { useProfileAvatar } from '../../hooks/useProfileAvatar'
import { AVATAR_SOURCE } from '../../lib/avatarConstants'
import { invoke } from '@tauri-apps/api/core'
import ImageCropper from '../ui/ImageCropper'
import SteamIconSolid from '../icons/SteamIconSolid'
import UbisoftIcon from '../icons/UbisoftIcon'
import './AvatarManager.css'

export default function AvatarManager({ isOpen, onClose }) {
  const { user } = useAuth()
  const { applyCustomAvatar, revertToGoogleAvatar, isUpdating } = useProfileAvatar()

  const [activeTab, setActiveTab] = useState('upload')
  const [stagedImage, setStagedImage] = useState(null)
  const [isClosing, setIsClosing] = useState(false)
  
  // Search state
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState([])
  const [isSearching, setIsSearching] = useState(false)
  const [searchError, setSearchError] = useState(null)

  const fileInputRef = useRef(null)

  // Clean up staged image URL when unmounting or passing to new tab
  useEffect(() => {
    return () => {
      if (stagedImage && stagedImage.startsWith('blob:')) {
        URL.revokeObjectURL(stagedImage)
      }
    }
  }, [stagedImage])

  // Reset closing state when reopened
  useEffect(() => {
    if (isOpen) setIsClosing(false)
  }, [isOpen])

  if (!isOpen && !isClosing) return null

  const handleClose = () => {
    if (isUpdating || isClosing) return
    setIsClosing(true)
    setTimeout(() => {
      setStagedImage(null)
      onClose()
      setIsClosing(false)
    }, 400) // matches CSS animation duration
  }

  const handleFileChange = (e) => {
    const file = e.target.files?.[0]
    if (!file) return
    if (!file.type.startsWith('image/')) return
    
    const url = URL.createObjectURL(file)
    setStagedImage(url)
  }

  const handleDrop = (e) => {
    e.preventDefault()
    const file = e.dataTransfer.files?.[0]
    if (file && file.type.startsWith('image/')) {
      const url = URL.createObjectURL(file)
      setStagedImage(url)
    }
  }

  const handleSearch = async () => {
    if (!searchQuery.trim()) return
    setIsSearching(true)
    setSearchError(null)
    try {
      const results = await searchWebImages(searchQuery.trim())
      setSearchResults(results.map(r => r.url))
    } catch (err) {
      setSearchError('Search failed. Please try a different query.')
    } finally {
      setIsSearching(false)
    }
  }

  const handleSelectWebImage = async (url) => {
    setIsSearching(true)
    setSearchError(null)
    try {
      // Use rust proxy to bypass CORS and prevent tainted canvas exports
      const b64 = await invoke('fetch_image_base64', { url })
      setStagedImage(`data:image/jpeg;base64,${b64}`)
    } catch (err) {
      console.error("Failed to fetch image via rust proxy:", err)
      setSearchError('Failed to load image. Please try another.')
    } finally {
      setIsSearching(false)
    }
  }

  const handleApplyCropped = async (blob) => {
    try {
      setSearchError(null)
      const source = activeTab === 'upload' ? AVATAR_SOURCE.UPLOADED : AVATAR_SOURCE.SEARCH;
      await applyCustomAvatar(blob, source)
      handleClose()
    } catch (err) {
      console.error("Failed to apply avatar:", err)
      setSearchError(`Save failed: ${err.message || JSON.stringify(err)}`)
    }
  }

  const handleRevert = async () => {
    try {
      setSearchError(null)
      await revertToGoogleAvatar()
      handleClose()
    } catch (err) {
      console.error("Failed to revert avatar:", err)
      setSearchError(`Revert failed: ${err.message || JSON.stringify(err)}`)
    }
  }

  return (
    <div className={`avatar-manager-overlay ${isClosing ? 'avatar-manager-overlay--closing' : ''}`} onClick={handleClose}>
      <div className={`avatar-manager ${isClosing ? 'avatar-manager--closing' : ''}`} onClick={e => e.stopPropagation()}>
        <div className="avatar-manager__header">
          <h3 className="avatar-manager__title">Change Avatar</h3>
          <button className="avatar-manager__close" onClick={handleClose} disabled={isUpdating}>
            <X size={20} />
          </button>
        </div>

        {stagedImage ? (
          <div className="avatar-manager__content">
             <ImageCropper 
               imageSrc={stagedImage} 
               onCancel={() => setStagedImage(null)}
               onApply={handleApplyCropped}
             />
             {isUpdating && (
               <div className="avatar-manager__message" style={{ color: 'var(--accent-primary)' }}>
                 <Loader size={18} className="avatar-manager__spin" style={{ marginRight: 8, verticalAlign: 'middle' }} />
                 Saving avatar...
               </div>
             )}
          </div>
        ) : (
          <>
            <div className="avatar-manager__tabs">
              <button 
                className={`avatar-manager__tab ${activeTab === 'upload' ? 'avatar-manager__tab--active' : ''}`}
                onClick={() => setActiveTab('upload')}
              >
                <Upload size={16} /> Upload
              </button>
              <button 
                className={`avatar-manager__tab ${activeTab === 'search' ? 'avatar-manager__tab--active' : ''}`}
                onClick={() => setActiveTab('search')}
              >
                <Search size={16} /> Search
              </button>
              <button 
                className={`avatar-manager__tab ${activeTab === 'platforms' ? 'avatar-manager__tab--active' : ''}`}
                onClick={() => setActiveTab('platforms')}
              >
                <Gamepad2 size={16} /> Platforms
              </button>
              <button 
                className={`avatar-manager__tab ${activeTab === 'google' ? 'avatar-manager__tab--active' : ''}`}
                onClick={() => setActiveTab('google')}
              >
                <Undo2 size={16} /> Google Default
              </button>
            </div>

            <div className="avatar-manager__content">
              {activeTab === 'upload' && (
                <div 
                  className="avatar-manager__upload-area"
                  onClick={() => fileInputRef.current?.click()}
                  onDragOver={e => e.preventDefault()}
                  onDrop={handleDrop}
                >
                  <Upload size={32} style={{ color: 'var(--text-muted)' }} />
                  <span>Click or drag and drop an image</span>
                  <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>PNG, JPG, WEBP (Max 5MB)</span>
                  <input 
                    type="file" 
                    ref={fileInputRef} 
                    onChange={handleFileChange} 
                    accept="image/png, image/jpeg, image/webp" 
                    style={{ display: 'none' }} 
                  />
                </div>
              )}

              {activeTab === 'search' && (
                <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
                  <div className="avatar-manager__search-bar">
                    <input 
                      type="text" 
                      className="avatar-manager__search-input" 
                      placeholder="Search for an avatar..." 
                      value={searchQuery}
                      onChange={e => setSearchQuery(e.target.value)}
                      onKeyDown={e => e.key === 'Enter' && handleSearch()}
                    />
                    <button className="avatar-manager__search-btn" onClick={handleSearch} disabled={isSearching}>
                      {isSearching ? <Loader size={18} className="avatar-manager__spin" /> : <Search size={18} />}
                    </button>
                  </div>
                  
                  {searchError && <div className="avatar-manager__message" style={{ color: 'var(--color-error)' }}>{searchError}</div>}
                  
                  {!isSearching && searchResults.length > 0 && (
                    <div className="avatar-manager__grid">
                      {searchResults.map((url, i) => (
                        <div key={i} className="avatar-manager__grid-item" onClick={() => handleSelectWebImage(url)}>
                          <img 
                            src={url} 
                            alt="Result" 
                            loading="lazy" 
                            onError={(e) => { e.target.parentElement.style.display = 'none'; }} 
                          />
                        </div>
                      ))}
                    </div>
                  )}
                  
                  {!isSearching && searchResults.length === 0 && !searchError && (
                    <div className="avatar-manager__message">
                      <ImageIcon size={32} style={{ opacity: 0.2, marginBottom: 8 }} />
                      <p>Search for characters, icons, or logos to use as your avatar.</p>
                    </div>
                  )}
                </div>
              )}

              {activeTab === 'platforms' && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                  <p className="avatar-manager__message" style={{ margin: 0, padding: '0 0 16px 0', textAlign: 'left' }}>
                    Select a profile picture from your connected gaming accounts.
                  </p>
                  
                  {!(localStorage.getItem("steamAvatarUrl")) && !(localStorage.getItem("ubisoftAvatarUrl")) && (
                    <div className="avatar-manager__upload-area" style={{ minHeight: 120 }}>
                      <Gamepad2 size={32} style={{ color: 'var(--text-muted)' }} />
                      <span>No connected accounts found</span>
                      <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>Link your accounts in Settings first.</span>
                    </div>
                  )}

                  {localStorage.getItem("steamAvatarUrl") && (
                    <div className="avatar-manager__platform-row" onClick={() => handleSelectWebImage(localStorage.getItem("steamAvatarUrl"))}>
                      <SteamIconSolid style={{ width: 24, height: 24 }} />
                      <div className="avatar-manager__platform-info">
                        <strong>Steam</strong>
                        <span>{localStorage.getItem('steamPersonaName') || 'Steam User'}</span>
                      </div>
                      <img src={localStorage.getItem("steamAvatarUrl")} alt="Steam" className="avatar-manager__platform-img" />
                    </div>
                  )}

                  {localStorage.getItem("ubisoftAvatarUrl") && (
                    <div className="avatar-manager__platform-row" onClick={() => handleSelectWebImage(localStorage.getItem("ubisoftAvatarUrl"))}>
                      <UbisoftIcon style={{ width: 24, height: 24 }} />
                      <div className="avatar-manager__platform-info">
                        <strong>Ubisoft Connect</strong>
                        <span>{localStorage.getItem('ubisoftUsername') || 'Ubisoft User'}</span>
                      </div>
                      <img src={localStorage.getItem("ubisoftAvatarUrl")} alt="Ubisoft" className="avatar-manager__platform-img" />
                    </div>
                  )}
                </div>
              )}

              {activeTab === 'google' && (
                <div className="avatar-manager__revert">
                  <img 
                    src={user?.user_metadata?.avatar_url || ''} 
                    alt="Google Default" 
                    className="avatar-manager__revert-img" 
                    onError={(e) => { e.target.style.display = 'none'; }}
                  />
                  <span>Revert to your original Google profile picture?</span>
                  <button 
                    className="avatar-manager__btn avatar-manager__btn--primary" 
                    onClick={handleRevert} 
                    disabled={isUpdating}
                    style={{ marginTop: 8 }}
                  >
                    {isUpdating ? 'Applying...' : 'Use Google Avatar'}
                  </button>
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  )
}

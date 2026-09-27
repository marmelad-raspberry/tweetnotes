    const FOLDER_DB_NAME = 'yu_folder_storage';
    const FOLDER_DB_VERSION = 1;
    const FOLDER_DB_STORE = 'settings';
    const FOLDER_DB_KEY = 'selectedFolder';

    let folderHandle = null;
    let profiles = [];
    let activeProfileId = null;
    let threadsData = [];
    let currentTab = 'home';
    let currentProfileContentTab = 'posts';

    let selectedMediaFiles = [];
    let editingPostElement = null;
    let replyingToThread = null;
    let replyingToPost = null;
    let composerProfileId = null;

    let viewerImages = [];
    let currentViewerIndex = 0;
    let activeFullUrls = [];
    let touchstartX = 0;
    let touchendX = 0;
    let isInitialProfileCreation = false;

    let virtualFeedQueue = [];
    let virtualSentinel = null;
    const VIRTUAL_BATCH_SIZE = 10;

    const mediaCache = new Map();

    const lazyMediaObserver = new IntersectionObserver(async (entries) => {
        for (const entry of entries) {
            const el = entry.target;
            const path = el.dataset.mediaPath;
            if (!path) continue;

            if (entry.isIntersecting) {
                if (!el.dataset.blobUrl && folderHandle) {
                    try {
                        let url = mediaCache.get(path);
                        if (!url) {
                            const mediaDir = await folderHandle.getDirectoryHandle('media', {create: true});
                            const fileHandle = await mediaDir.getFileHandle(path);
                            const file = await fileHandle.getFile();
                            url = URL.createObjectURL(file);
                            mediaCache.set(path, url); if (mediaCache.size > 100) { const first = mediaCache.keys().next().value; URL.revokeObjectURL(mediaCache.get(first)); mediaCache.delete(first); }
                        }
                        el.dataset.blobUrl = url;
                        if (el.tagName === 'IMG' || el.tagName === 'VIDEO') el.src = url;
                        else el.style.backgroundImage = `url("${url}")`;
                    } catch (e) {}
                }
            }
        }
    }, { rootMargin: '400px 0px' });

    function setMediaElement(el, urlOrPath) {
        if (!el) return;
        lazyMediaObserver.unobserve(el);
        if (!urlOrPath) {
            delete el.dataset.blobUrl;
            delete el.dataset.mediaPath;
            if (el.tagName === 'IMG' || el.tagName === 'VIDEO') el.removeAttribute('src');
            else el.style.backgroundImage = 'none';
            return;
        }
        if (urlOrPath.startsWith('blob:') || urlOrPath.startsWith('http') || urlOrPath.startsWith('data:')) {
            delete el.dataset.blobUrl;
            delete el.dataset.mediaPath;
            if (el.tagName === 'IMG' || el.tagName === 'VIDEO') el.src = urlOrPath;
            else el.style.backgroundImage = `url("${urlOrPath}")`;
        } else {
            el.dataset.mediaPath = urlOrPath;
            if (mediaCache.has(urlOrPath)) {
                const url = mediaCache.get(urlOrPath);
                el.dataset.blobUrl = url;
                if (el.tagName === 'IMG' || el.tagName === 'VIDEO') el.src = url;
                else el.style.backgroundImage = `url("${url}")`;
            } else {
                delete el.dataset.blobUrl; if (el.tagName === 'IMG' || el.tagName === 'VIDEO') el.removeAttribute('src'); else el.style.backgroundImage = 'none'; lazyMediaObserver.observe(el);
            }
        }
    }

    const virtualDomObserver = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
            const el = entry.target;
            if (document.body.classList.contains('in-thread-view') && el.classList.contains('active-thread')) {
                if (el.virtualNodeStorage) {
                    el.style.minHeight = '';
                    el.appendChild(el.virtualNodeStorage);
                    el.virtualNodeStorage = null;
                    el.dataset.virtualized = 'false';
                }
                return;
            }
            if (entry.isIntersecting) {
                if (el.virtualNodeStorage) {
                    el.style.minHeight = '';
                    el.appendChild(el.virtualNodeStorage);
                    el.virtualNodeStorage = null;
                    el.dataset.virtualized = 'false';
                }
            } else {
                if (el.dataset.virtualized !== 'true' && el.offsetHeight > 0) {
                    requestAnimationFrame(() => { el.style.minHeight = el.offsetHeight + 'px'; });
                    const frag = document.createDocumentFragment();
                    while (el.firstChild) { frag.appendChild(el.firstChild); }
                    el.virtualNodeStorage = frag;
                    el.dataset.virtualized = 'true';
                }
            }
        });
    }, { rootMargin: '1200px 0px' });

    const virtualScrollObserver = new IntersectionObserver((entries) => {
        if (entries[0].isIntersecting) renderVirtualBatch();
    }, { rootMargin: '600px 0px' });

    function startVirtualFeed(feedElement, initialItems = []) {
        virtualFeedQueue = initialItems;
        feedElement.innerHTML = '';
        renderVirtualBatch();
        if (!virtualSentinel) {
            virtualSentinel = document.createElement('div');
            virtualSentinel.id = 'virtualSentinel';
            virtualSentinel.style.height = '20px';
            virtualSentinel.style.width = '100%';
        }
        feedElement.appendChild(virtualSentinel);
        virtualScrollObserver.observe(virtualSentinel);
    }

    function renderVirtualBatch() {
        const feed = document.getElementById('feed');
        if (!feed || virtualFeedQueue.length === 0) return;
        
        const fragment = document.createDocumentFragment();
        const batch = virtualFeedQueue.splice(0, VIRTUAL_BATCH_SIZE);
        
        batch.forEach(itemFn => {
            const el = itemFn();
            if (el) {
                virtualDomObserver.observe(el);
                fragment.appendChild(el);
            }
        });
        
        if (virtualSentinel && feed.contains(virtualSentinel)) {
            feed.insertBefore(fragment, virtualSentinel);
        } else {
            feed.appendChild(fragment);
        }
        
        if (virtualFeedQueue.length === 0 && virtualSentinel) {
            virtualScrollObserver.unobserve(virtualSentinel);
            if (feed.contains(virtualSentinel)) feed.removeChild(virtualSentinel);
        }
    }

    function updateStorageStatus(message) {
        const el = document.getElementById('storageStatus');
        if (el) el.innerHTML = `<strong>Carpeta:</strong> ${message}`;
    }

    async function writeFile(dirHandle, filename, data) {
        const fileHandle = await dirHandle.getFileHandle(filename, { create: true });
        const writable = await fileHandle.createWritable();
        await writable.write(data);
        await writable.close();
    }

    async function writeJsonFile(dirHandle, filename, obj) {
        await writeFile(dirHandle, filename, JSON.stringify(obj, null, 2));
    }

    async function getMediaUrl(dirHandle, filename) {
        try {
            const fileHandle = await dirHandle.getFileHandle(filename);
            const file = await fileHandle.getFile();
            return URL.createObjectURL(file);
        } catch (e) { return ''; }
    }

    async function deleteMediaFile(filename) {
        if (!filename || !folderHandle) return;
        try {
            const mediaDir = await folderHandle.getDirectoryHandle('media', {create: true});
            await mediaDir.removeEntry(filename);
            if (mediaCache.has(filename)) {
                URL.revokeObjectURL(mediaCache.get(filename));
                mediaCache.delete(filename);
            }
        } catch(e) {}
    }

    async function generateThumbnail(file) {
        return new Promise((resolve) => {
            const isVid = file.type.startsWith('video/');
            const url = URL.createObjectURL(file);
            const canvas = document.createElement('canvas');
            const ctx = canvas.getContext('2d');

            if (isVid) {
                const video = document.createElement('video');
                video.src = url;
                video.muted = true;
                video.playsInline = true;
                let isResolved = false;

                const finish = () => {
                    if(isResolved) return; isResolved = true;
                    const scale = Math.min(800 / (video.videoWidth || 800), 800 / (video.videoHeight || 800));
                    canvas.width = (video.videoWidth || 400) * scale;
                    canvas.height = (video.videoHeight || 400) * scale;
                    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
                    canvas.toBlob(blob => { URL.revokeObjectURL(url); resolve(blob); }, 'image/jpeg', 0.6);
                };

                video.addEventListener('loadeddata', () => { video.currentTime = Math.min(1, video.duration / 2 || 1); });
                video.addEventListener('seeked', finish);
                video.addEventListener('error', finish);
                setTimeout(finish, 2000); 
            } else {
                const img = new Image();
                img.onload = () => {
                    const scale = Math.min(800 / img.width, 800 / img.height);
                    canvas.width = img.width * scale;
                    canvas.height = img.height * scale;
                    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
                    canvas.toBlob(blob => { URL.revokeObjectURL(url); resolve(blob); }, 'image/jpeg', 0.6);
                };
                img.onerror = () => { URL.revokeObjectURL(url); resolve(new Blob([])); };
                img.src = url;
            }
        });
    }

    async function saveSettingsToFolder() {
        if (!folderHandle) return;
        await writeJsonFile(folderHandle, 'settings.json', { activeProfileId });
    }

    async function saveProfileToFolder(profile) {
        if (!folderHandle) return;
        const profilesDir = await folderHandle.getDirectoryHandle('profiles', {create: true});
        const mediaDir = await folderHandle.getDirectoryHandle('media', {create: true});
        const p = {...profile};
        
        if (p.avatarFile) {
            const ext = p.avatarFile.name.split('.').pop() || 'png';
            const filename = `${p.id}_avatar.${ext}`;
            await writeFile(mediaDir, filename, p.avatarFile);
            p.avatarPath = filename; const thumbBlobAv = await generateThumbnail(p.avatarFile); const thumbFileAv = `${p.id}_avatar_thumb.jpg`; await writeFile(mediaDir, thumbFileAv, thumbBlobAv); p.avatarThumbPath = thumbFileAv;
            delete p.avatarFile;
        }
        if (p.coverFile) {
            const ext = p.coverFile.name.split('.').pop() || 'png';
            const filename = `${p.id}_cover.${ext}`;
            await writeFile(mediaDir, filename, p.coverFile);
            p.coverPath = filename; const thumbBlobCov = await generateThumbnail(p.coverFile); const thumbFileCov = `${p.id}_cover_thumb.jpg`; await writeFile(mediaDir, thumbFileCov, thumbBlobCov); p.coverThumbPath = thumbFileCov;
            delete p.coverFile;
        }
        delete p.avatar; delete p.cover; delete p.avatarThumb; delete p.coverThumb;
        await writeJsonFile(profilesDir, `${p.id}.json`, p);
    }

    async function saveThreadToFolder(thread) {
        if (!folderHandle) return;
        const threadsDir = await folderHandle.getDirectoryHandle('threads', {create: true});
        const mediaDir = await folderHandle.getDirectoryHandle('media', {create: true});
        const t = JSON.parse(JSON.stringify(thread));
        
        for (let i = 0; i < thread.posts.length; i++) {
            let origPost = thread.posts[i];
            let savePost = t.posts[i];
            for (let j = 0; j < (origPost.media || []).length; j++) {
                let m = origPost.media[j];
                if (m.file) {
                    const ext = m.file.name.split('.').pop() || (m.isVideo ? 'mp4' : 'jpg');
                    const filename = `${origPost.id}_${j}.${ext}`;
                    await writeFile(mediaDir, filename, m.file);
                    m.path = filename;
                    savePost.media[j].path = filename;

                    if (m.thumbBlob) {
                        const thumbFilename = `${origPost.id}_${j}_thumb.jpg`;
                        await writeFile(mediaDir, thumbFilename, m.thumbBlob);
                        m.thumbPath = thumbFilename;
                        savePost.media[j].thumbPath = thumbFilename;
                    }

                    delete m.file;
                    delete m.thumbBlob;
                }
                delete savePost.media[j].url;
                delete savePost.media[j].thumbnailUrl;
                delete savePost.media[j].file;
                delete savePost.media[j].thumbBlob;
            }
        }
        await writeJsonFile(threadsDir, `${t.id}.json`, t);
    }

    async function deleteThreadFromFolder(threadId) {
        if (!folderHandle) return;
        try {
            const threadsDir = await folderHandle.getDirectoryHandle('threads', {create: true});
            await threadsDir.removeEntry(`${threadId}.json`);
        } catch(e) {}
    }

    async function deleteProfileFromFolder(profileId) {
        if (!folderHandle) return;
        try {
            const profilesDir = await folderHandle.getDirectoryHandle('profiles', {create: true});
            await profilesDir.removeEntry(`${profileId}.json`);
        } catch(e) {}
    }

    async function loadStateFromFolder() { try { await folderHandle.getFileHandle(".nomedia"); } catch(e) { try { await writeFile(folderHandle, ".nomedia", ""); } catch(err) {} }
        profiles = [];
        threadsData = [];
        
        const profilesDir = await folderHandle.getDirectoryHandle('profiles', {create: true});
        const threadsDir = await folderHandle.getDirectoryHandle('threads', {create: true});

        try {
            const settingsFile = await folderHandle.getFileHandle('settings.json');
            const settingsText = await (await settingsFile.getFile()).text();
            activeProfileId = JSON.parse(settingsText).activeProfileId;
        } catch(e) { activeProfileId = null; }

        for await (const entry of profilesDir.values()) {
            if (entry.kind === 'file' && entry.name.endsWith('.json')) {
                try {
                    const p = JSON.parse(await (await entry.getFile()).text());
                    profiles.push(p);
                } catch(e) {}
            }
        }

        for await (const entry of threadsDir.values()) {
            if (entry.kind === 'file' && entry.name.endsWith('.json')) {
                try {
                    const t = JSON.parse(await (await entry.getFile()).text());
                    threadsData.push(t);
                } catch(e) {}
            }
        }
        
        threadsData.sort((a,b) => b.id.localeCompare(a.id));
        if (profiles.length > 0 && !profiles.some(p => p.id === activeProfileId)) activeProfileId = profiles[0].id;
    }

    async function finishFolderLoad() {
        updateStorageStatus(folderHandle.name);
        document.getElementById('clearStoredFolderBtn').style.display = 'block';
        document.body.classList.remove('app-uninitialized');

        if (profiles.length === 0) {
            isInitialProfileCreation = true;
            document.getElementById('feed').innerHTML = '';
            openNewProfileModal(true);
            hideStartupOverlay();
            return false;
        }

        renderCurrentProfileUI();
        renderAllFeed();
        switchTab('home');
        hideStartupOverlay();
        return true;
    }

    function showStartupOverlay(message = null, storedHandle = null) {
        const overlay = document.getElementById('startupOverlay');
        const messageEl = document.getElementById('startupMessage');
        const storedBtn = document.getElementById('useStoredFolderBtn');
        document.body.classList.add('app-uninitialized');
        overlay.style.display = 'flex';
        if (message) messageEl.textContent = message;
        if (storedHandle) { storedBtn.style.display = 'block'; storedBtn.textContent = `Usar carpeta: ${storedHandle.name}`; } 
        else { storedBtn.style.display = 'none'; }
    }

    function hideStartupOverlay() { document.getElementById('startupOverlay').style.display = 'none'; document.body.classList.remove('app-uninitialized'); }

    async function activateFolder(handle) {
        folderHandle = handle;
        await loadStateFromFolder();
        return finishFolderLoad();
    }

    function openFolderDatabase() {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(FOLDER_DB_NAME, FOLDER_DB_VERSION);
            request.onupgradeneeded = () => { if (!request.result.objectStoreNames.contains(FOLDER_DB_STORE)) request.result.createObjectStore(FOLDER_DB_STORE); };
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    }

    async function storeFolderHandle(handle) {
        const db = await openFolderDatabase();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(FOLDER_DB_STORE, 'readwrite');
            tx.objectStore(FOLDER_DB_STORE).put(handle, FOLDER_DB_KEY);
            tx.oncomplete = () => { db.close(); resolve(); };
            tx.onerror = () => { db.close(); reject(tx.error); };
        });
    }

    async function getStoredFolderHandle() {
        try {
            const db = await openFolderDatabase();
            return new Promise((resolve, reject) => {
                const tx = db.transaction(FOLDER_DB_STORE, 'readonly');
                const request = tx.objectStore(FOLDER_DB_STORE).get(FOLDER_DB_KEY);
                request.onsuccess = () => resolve(request.result || null);
                request.onerror = () => reject(request.error);
                tx.oncomplete = () => db.close();
            });
        } catch(e) { return null; }
    }

    async function removeStoredFolderHandle() {
        try {
            const db = await openFolderDatabase();
            await new Promise((resolve, reject) => {
                const tx = db.transaction(FOLDER_DB_STORE, 'readwrite');
                tx.objectStore(FOLDER_DB_STORE).delete(FOLDER_DB_KEY);
                tx.oncomplete = resolve;
                tx.onerror = () => reject();
            });
            db.close();
        } catch (e) {}
    }

    async function ensureFolderPermission(handle, requestIfNeeded = false) {
        if (!handle) return false;
        try {
            if ((await handle.queryPermission({ mode: 'readwrite' })) === 'granted') return true;
            if (requestIfNeeded) return (await handle.requestPermission({ mode: 'readwrite' })) === 'granted';
        } catch (e) {}
        return false;
    }

    async function requestStoredFolderAccess() {
        try {
            const storedHandle = await getStoredFolderHandle();
            if (!storedHandle) { await chooseStorageFolder(); return; }
            if (!(await ensureFolderPermission(storedHandle, true))) return;
            await activateFolder(storedHandle);
            closeHomeTools();
        } catch (e) { alert('No se pudo recuperar la carpeta.'); }
    }

    async function chooseStorageFolder() {
        if (!('showDirectoryPicker' in window)) { alert('Navegador no compatible.'); return; }
        try {
            const selected = await window.showDirectoryPicker({ mode: 'readwrite' });
            await storeFolderHandle(selected);
            await activateFolder(selected);
            closeHomeTools();
        } catch (e) { }
    }

    async function forgetStoredFolder() {
        folderHandle = null; profiles = []; threadsData = [];
        await removeStoredFolderHandle();
        updateStorageStatus('Ninguna');
        document.getElementById('clearStoredFolderBtn').style.display = 'none';
        showStartupOverlay('Selecciona una carpeta para comenzar.');
        document.getElementById('feed').innerHTML = '';
        closeHomeTools();
    }

    function formatUniqueHandle(inputHandle, excludeProfileId = null) {
        let cleanHandle = inputHandle.replace(/^@/, '').replace(/[^a-zA-Z0-9_]/g, '').toLowerCase() || 'usuario';
        let testHandle = '@' + cleanHandle;
        let counter = 1;
        while (profiles.some(p => p.handle === testHandle && p.id !== excludeProfileId)) {
            testHandle = '@' + cleanHandle + counter; counter++;
        }
        return testHandle;
    }

    document.addEventListener('click', function(e) {
        if(!e.target.closest('.post-options-btn') && !e.target.closest('.profile-dropdown-btn')) document.querySelectorAll('.post-dropdown').forEach(d => d.style.display = 'none');
        if(!e.target.closest('.home-tools-wrapper')) closeHomeTools();
    });

    function toggleHomeTools(e) { e.stopPropagation(); const menu = document.getElementById('homeToolsDropdown'); menu.classList.toggle('open'); }
    function closeHomeTools() { const menu = document.getElementById('homeToolsDropdown'); if (menu) menu.classList.remove('open'); }

    function switchTab(tab, searchQuery = null) {
        const previousTab = currentTab; currentTab = tab;
        if (tab === 'profile' && previousTab !== 'profile') currentProfileContentTab = 'posts';
        document.getElementById('tabHome').classList.toggle('active', tab === 'home');
        document.getElementById('tabSearch').classList.toggle('active', tab === 'search');
        document.getElementById('tabProfile').classList.toggle('active', tab === 'profile');
        document.getElementById('homeToolbar').style.display = tab === 'home' ? 'flex' : 'none';
        document.getElementById('searchPage').style.display = tab === 'search' ? 'block' : 'none';
        closeHomeTools();

        if (!document.body.classList.contains('in-thread-view')) {
            document.getElementById('coverPhoto').style.display = tab === 'profile' ? 'block' : 'none';
            document.querySelector('.profile-header').style.display = tab === 'profile' ? 'block' : 'none';
        }

        if (tab === 'home') { document.getElementById('feed').classList.remove('search-results'); renderAllFeed(); } 
        else if (tab === 'profile') renderProfileContent();
        else if (tab === 'search') { const input = document.getElementById('searchInput'); if (searchQuery !== null) input.value = searchQuery; renderSearchResults(input.value); setTimeout(() => input.focus(), 0); }
        updateFeedVisibility();
    }

    function updateFeedVisibility() {
        if (document.body.classList.contains('in-thread-view')) return;
        document.querySelectorAll('.thread-container').forEach(thread => thread.style.display = 'block');
    }

    function escapeHtml(value) { return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\"/g, '&quot;').replace(/'/g, '&#039;'); }
    function renderTextWithHashtags(text) { return escapeHtml(text).replace(/\n/g, '<br>').replace(/(^|[\s(])(#(?:[\p{L}\p{N}_][\p{L}\p{N}_-]*))/gu, (m, p, h) => `${p}<a href=\"#\" class=\"hashtag-link\" data-hashtag=\"${h.replace(/'/g, '&#039;')}\" onclick=\"searchHashtag(event, this.dataset.hashtag)\">${h}</a>`); }
    function normalizeSearchText(v) { return String(v || '').trim().toLocaleLowerCase(); }
    function getSearchTerms(q) { return normalizeSearchText(q).split(/\s+/).map(t => t.replace(/^#+/, '#')).filter(Boolean); }
    function postMatchesSearch(post, q) { const terms = getSearchTerms(q); if (!terms.length) return false; const haystack = normalizeSearchText(post.text); return terms.every(t => haystack.includes(t)); }
    function searchHashtag(e, h) { e.preventDefault(); e.stopPropagation(); switchTab('search', h); }
    function profileMatchesSearch(p, q) { const terms = getSearchTerms(q); if (!terms.length) return false; const handle = normalizeSearchText(p.handle).replace(/^@/, ''); const haystack = normalizeSearchText(`${handle} ${p.name || ''} ${p.bio || ''}`); const handleQ = normalizeSearchText(q).replace(/^@/, '').trim(); if (handleQ && handle.includes(handleQ)) return true; return terms.every(t => { const clean = t.replace(/^@/, ''); return !clean || haystack.includes(clean); }); }

    function renderSearchResults(query = '') {
        const feed = document.getElementById('feed'); const q = String(query || '').trim();
        feed.classList.add('search-results');
        if (!q) { feed.innerHTML = ''; return; }
        
        let queue = [];
        
        const matchedProfiles = profiles.filter(p => profileMatchesSearch(p, q));
        if (matchedProfiles.length > 0) {
            queue.push(() => {
                const wrap = document.createElement('div');
                const title = document.createElement('div'); title.className = 'search-section-title'; title.textContent = 'Perfiles'; wrap.appendChild(title);
                const list = document.createElement('div'); list.className = 'search-profile-list';
                matchedProfiles.forEach(p => {
                    const card = document.createElement('div'); card.className = 'search-profile-card'; card.setAttribute('role', 'button'); card.tabIndex = 0;
                    const avatar = document.createElement('div'); avatar.className = 'search-profile-avatar'; setMediaElement(avatar, p.avatarThumb || p.avatarThumbPath || p.avatar || p.avatarPath);
                    const info = document.createElement('div'); info.className = 'search-profile-info';
                    const name = document.createElement('span'); name.className = 'search-profile-name'; name.textContent = p.name || 'Usuario';
                    const handle = document.createElement('span'); handle.className = 'search-profile-handle'; handle.textContent = p.handle || '@usuario';
                    info.appendChild(name); info.appendChild(handle);
                    if (p.bio) { const bio = document.createElement('div'); bio.className = 'search-profile-bio'; bio.textContent = p.bio; info.appendChild(bio); }
                    card.appendChild(avatar); card.appendChild(info);
                    const go = e => openProfile(p.id, e); card.addEventListener('click', go); card.addEventListener('keydown', e => { if(e.key==='Enter'||e.key===' ') go(e); });
                    list.appendChild(card);
                });
                wrap.appendChild(list);
                return wrap;
            });
        }
        
        let pFound = 0;
        const threadQueue = [];
        threadsData.forEach(t => {
            const matching = (t.posts || []).filter(p => postMatchesSearch(p, q));
            if (!matching.length) return;
            pFound += matching.length;
            
            threadQueue.push(() => {
                const tc = document.createElement('div'); tc.className = 'thread-container'; tc.dataset.threadId = t.id;
                (t.posts || []).forEach(p => {
                    const div = createPostElement(p);
                    if (postMatchesSearch(p, q)) { div.classList.add('search-match'); div.onclick = function(e) { viewThread(this, e); }; }
                    tc.appendChild(div);
                });
                return tc;
            });
        });

        if (pFound > 0) {
            queue.push(() => { const pt = document.createElement('div'); pt.className = 'search-section-title search-posts-title'; pt.textContent = 'Posts'; return pt; });
            queue.push(...threadQueue);
        }

        if (matchedProfiles.length === 0 && pFound === 0) {
            queue.push(() => { const empty = document.createElement('div'); empty.className = 'search-empty-state'; empty.textContent = 'No se encontraron resultados.'; return empty; });
        }

        startVirtualFeed(feed, queue);
    }

    function renderAllFeed() {
        const feed = document.getElementById('feed'); 
        const queue = threadsData.map(t => () => {
            const tc = document.createElement('div'); tc.className = 'thread-container'; tc.dataset.threadId = t.id;
            t.posts.forEach((p, i) => { const div = createPostElement(p, i === 0 ? function(e){viewThread(this, e);} : null); tc.appendChild(div); });
            return tc;
        });
        
        startVirtualFeed(feed, queue);
        
        if (currentTab === 'profile' && !document.body.classList.contains('in-thread-view')) renderProfileContent(); else updateFeedVisibility();
        
        if (document.body.classList.contains('in-thread-view') && window.activeThreadId) { 
            while (virtualFeedQueue.length > 0 && !document.querySelector(`.thread-container[data-thread-id="${window.activeThreadId}"]`)) {
                renderVirtualBatch();
            }
            const aTh = document.querySelector(`.thread-container[data-thread-id="${window.activeThreadId}"]`); 
            if(aTh) { aTh.classList.add('active-thread'); aTh.style.display = 'block'; } else closeThreadView(); 
        }
    }

    function renderProfileDropdown() {
        const c = document.getElementById('profileListContainer'); c.innerHTML = '';
        profiles.forEach(p => {
            const item = document.createElement('div'); item.className = 'post-dropdown-item'; item.style.display = 'flex'; item.style.alignItems = 'center'; item.style.gap = '10px';
            const av = document.createElement('div'); av.style.width = '30px'; av.style.height = '30px'; av.style.borderRadius = '50%'; av.style.backgroundColor = '#cfd9de'; av.style.backgroundSize = 'cover'; av.style.backgroundPosition = 'center'; av.style.flexShrink = '0'; setMediaElement(av, p.avatarThumb || p.avatarThumbPath || p.avatar || p.avatarPath);
            const tC = document.createElement('div'); tC.style.display = 'flex'; tC.style.flexDirection = 'column'; tC.style.overflow = 'hidden';
            const n = document.createElement('span'); n.innerText = p.name; n.style.fontWeight = p.id === activeProfileId ? '800' : '600'; n.style.whiteSpace = 'nowrap'; n.style.textOverflow = 'ellipsis'; n.style.overflow = 'hidden';
            const h = document.createElement('span'); h.innerText = p.handle; h.style.fontSize = '13px'; h.style.color = 'var(--text-muted)';
            tC.appendChild(n); tC.appendChild(h); if (p.id === activeProfileId) item.style.backgroundColor = 'rgba(29, 155, 240, 0.05)';
            item.appendChild(av); item.appendChild(tC); item.onclick = () => switchProfile(p.id); c.appendChild(item);
        });
    }

    function toggleProfileDropdown(e) { e.stopPropagation(); const dp = document.getElementById('profileDropdown'); const v = dp.style.display === 'block'; document.querySelectorAll('.post-dropdown').forEach(d => d.style.display = 'none'); if (!v) { renderProfileDropdown(); dp.style.display = 'block'; } }

    function openNewProfileModal(initial = false) {
        document.getElementById('profileDropdown').style.display = 'none';
        ['newName','newHandle','newBio','newProfilePic','newCoverPic'].forEach(id => document.getElementById(id).value = '');
        isInitialProfileCreation = initial;
        document.getElementById('newProfileModalTitle').textContent = initial ? 'Crea tu perfil' : 'Nuevo perfil';
        document.getElementById('newProfileCloseBtn').style.visibility = initial ? 'hidden' : 'visible';
        document.getElementById('newName').placeholder = initial ? 'Tu nombre' : 'Ej. Juan Pérez';
        document.getElementById('newHandle').placeholder = initial ? '@tuusuario' : 'Ej. @juanp';
        document.getElementById('newProfileModal').style.display = 'flex';
        if (initial) setTimeout(() => document.getElementById('newName').focus(), 50);
    }

    function closeNewProfileModal() { if (!isInitialProfileCreation) document.getElementById('newProfileModal').style.display = 'none'; }

    async function createNewProfile() {
        const init = isInitialProfileCreation;
        const nInput = document.getElementById('newName').value.trim(); const hInput = document.getElementById('newHandle').value.trim();
        if (init && (!nInput || !hInput)) { alert('Introduce nombre y usuario.'); return; }
        
        const np = {
            id: 'prof_' + Date.now(),
            name: nInput || 'Nuevo Usuario',
            handle: formatUniqueHandle(hInput || 'nuevousuario'),
            bio: document.getElementById('newBio').value.trim(),
        };

        const avFile = document.getElementById('newProfilePic').files[0];
        const covFile = document.getElementById('newCoverPic').files[0];
        if (avFile) { np.avatarFile = avFile; np.avatar = URL.createObjectURL(avFile); np.avatarThumb = URL.createObjectURL(await generateThumbnail(avFile)); }
        if (covFile) { np.coverFile = covFile; np.cover = URL.createObjectURL(covFile); np.coverThumb = URL.createObjectURL(await generateThumbnail(covFile)); }

        profiles.push(np); activeProfileId = np.id;
        await saveProfileToFolder(np);
        await saveSettingsToFolder();

        isInitialProfileCreation = false;
        document.getElementById('newProfileModal').style.display = 'none';
        renderCurrentProfileUI(); renderAllFeed(); switchTab('home'); hideStartupOverlay();
    }

    async function switchProfile(id) { activeProfileId = id; await saveSettingsToFolder(); document.getElementById('profileDropdown').style.display = 'none'; renderCurrentProfileUI(); if (currentTab === 'profile') renderProfileContent(); else updateFeedVisibility(); }

    async function openProfile(pid, e = null) {
        if (e) { e.preventDefault(); e.stopPropagation(); }
        const p = profiles.find(x => x.id === pid); if (!p) return;
        activeProfileId = p.id; composerProfileId = p.id; await saveSettingsToFolder(); closeHomeTools(); document.getElementById('profileDropdown').style.display = 'none'; renderCurrentProfileUI(); switchTab('profile'); window.scrollTo(0, 0);
    }

    function renderCurrentProfileUI() {
        const p = profiles.find(x => x.id === activeProfileId) || profiles[0]; if (!p) return;
        document.getElementById('displayName').innerText = p.name; document.getElementById('displayHandle').innerText = p.handle;
        const b = document.getElementById('displayBio'); if (p.bio) { b.innerText = p.bio; b.style.display = 'block'; } else { b.innerText = ''; b.style.display = 'none'; }
        setMediaElement(document.getElementById('profilePic'), p.avatar || p.avatarPath);
        setMediaElement(document.getElementById('modalComposeAvatar'), p.avatarThumb || p.avatarThumbPath || p.avatar || p.avatarPath);
        setMediaElement(document.getElementById('coverPhoto'), p.cover || p.coverPath);
    }

    function getMainPost(t) { return t.posts?.length ? t.posts[0] : null; }
    function getProfileMainThreads(pid) { return threadsData.filter(t => getMainPost(t)?.authorId === pid); }
    function getProfileReplies(pid) { const r = []; threadsData.forEach(t => { const m = getMainPost(t); if (!m || !t.posts) return; t.posts.slice(1).forEach(rp => { if (rp.authorId === pid) r.push({ thread: t, mainPost: m, reply: rp }); }); }); return r; }

    function createPostElement(p, onClick = null) {
        const div = document.createElement('div'); div.className = 'post'; div.dataset.id = p.id; div.dataset.rawText = p.text || ''; div.dataset.isAdvanced = p.isAdvanced || false; div.dataset.replyCount = p.replyCount || 0; div.dataset.authorId = p.authorId; div.mediaData = p.media || [];
        if (onClick) div.onclick = onClick; renderPostContent(div, p.text, p.media); return div;
    }

    function switchProfileContentTab(t) { currentProfileContentTab = t; document.getElementById('profileTabPosts').classList.toggle('active', t === 'posts'); document.getElementById('profileTabReplies').classList.toggle('active', t === 'replies'); if (currentTab === 'profile' && !document.body.classList.contains('in-thread-view')) { renderProfileContent(); window.scrollTo(0, 0); } }

    function renderProfileContent() {
        if (currentTab !== 'profile' || document.body.classList.contains('in-thread-view')) return;
        const feed = document.getElementById('feed'); feed.classList.remove('search-results'); 
        
        let queue = [];
        
        if (currentProfileContentTab === 'posts') {
            queue = getProfileMainThreads(activeProfileId).map(t => () => {
                const tc = document.createElement('div'); tc.className = 'thread-container'; tc.dataset.threadId = t.id;
                (t.posts || []).forEach((p, i) => tc.appendChild(createPostElement(p, i === 0 ? function(e){viewThread(this, e);} : null))); 
                return tc;
            });
            if (queue.length === 0) queue.push(() => { const e = document.createElement('div'); e.className = 'search-empty-state'; e.textContent = 'Sin posts.'; return e; });
        } else {
            queue = getProfileReplies(activeProfileId).map(({ thread, mainPost, reply }) => () => {
                const w = document.createElement('div'); w.className = 'profile-response-context'; w.dataset.threadId = thread.id;
                const l = document.createElement('div'); l.className = 'context-label'; l.textContent = 'Respondió a'; w.appendChild(l);
                const cp = createPostElement(mainPost, function(e) { viewThreadById(thread.id, e); }); cp.classList.add('context-post'); w.appendChild(cp);
                const rp = createPostElement(reply); rp.classList.add('response-post'); w.appendChild(rp); 
                return w;
            });
            if (queue.length === 0) queue.push(() => { const e = document.createElement('div'); e.className = 'search-empty-state'; e.textContent = 'Sin respuestas.'; return e; });
        }
        
        startVirtualFeed(feed, queue);
    }

    function viewThreadById(tid, e) {
        let tc = document.querySelector(`.thread-container[data-thread-id="${tid}"]`); 
        if (tc) { 
            if (tc.virtualNodeStorage) { tc.style.minHeight = ''; tc.appendChild(tc.virtualNodeStorage); tc.virtualNodeStorage = null; tc.dataset.virtualized = 'false'; }
            const fp = tc.querySelector('.post'); if (fp) viewThread(fp, e); return; 
        }
        
        if (!threadsData.find(t => t.id === tid)) return;
        currentTab = 'home'; document.getElementById('tabHome').classList.add('active'); document.getElementById('tabSearch').classList.remove('active'); document.getElementById('tabProfile').classList.remove('active'); document.getElementById('homeToolbar').style.display = 'flex'; document.getElementById('searchPage').style.display = 'none'; document.getElementById('coverPhoto').style.display = 'none'; document.querySelector('.profile-header').style.display = 'none'; 
        renderAllFeed();
        
        while (virtualFeedQueue.length > 0 && !document.querySelector(`.thread-container[data-thread-id="${tid}"]`)) {
            renderVirtualBatch();
        }
        
        const aTc = document.querySelector(`.thread-container[data-thread-id="${tid}"]`); 
        if (aTc) { 
            if (aTc.virtualNodeStorage) { aTc.style.minHeight = ''; aTc.appendChild(aTc.virtualNodeStorage); aTc.virtualNodeStorage = null; aTc.dataset.virtualized = 'false'; }
            const fp = aTc.querySelector('.post'); if (fp) viewThread(fp, e); 
        }
    }

    function viewThread(el, e) {
        if(document.body.classList.contains('in-thread-view') || e.target.closest('button') || e.target.closest('.post-dropdown') || e.target.closest('.media-item-wrap') || e.target.closest('.action-icons') || e.target.closest('.hashtag-link')) return;
        document.querySelector('.cover-photo').style.display = 'none'; document.querySelector('.profile-header').style.display = 'none'; document.getElementById('threadHeader').style.display = 'flex';
        const at = el.closest('.thread-container'); at.classList.add('active-thread'); window.activeThreadId = at.dataset.threadId;
        document.querySelectorAll('.thread-container').forEach(th => { if(th !== at) th.style.display = 'none'; });
        document.body.classList.add('in-thread-view'); window.scrollTo(0, 0);
    }

    function closeThreadView() {
        window.activeThreadId = null; if (currentTab === 'profile') { document.querySelector('.cover-photo').style.display = 'block'; document.querySelector('.profile-header').style.display = 'block'; }
        document.getElementById('threadHeader').style.display = 'none'; document.querySelectorAll('.thread-container').forEach(th => th.classList.remove('active-thread')); document.body.classList.remove('in-thread-view');
        if (currentTab === 'search') renderSearchResults(document.getElementById('searchInput').value); else if (currentTab === 'profile') renderProfileContent(); else updateFeedVisibility();
    }

    function openEditModal() { const p = profiles.find(x => x.id === activeProfileId); document.getElementById('editName').value = p.name; document.getElementById('editHandle').value = p.handle; document.getElementById('editBio').value = p.bio; document.getElementById('deleteProfileBtn').style.display = profiles.length > 1 ? 'block' : 'none'; document.getElementById('editModal').style.display = 'flex'; }
    function closeEditModal() { document.getElementById('editModal').style.display = 'none'; }

    function renderComposerProfileOptions(selId = null) {
        const sel = document.getElementById('postProfileSelect'); if (!sel) return;
        const prefId = selId || composerProfileId || activeProfileId; sel.innerHTML = '';
        profiles.forEach(p => { const opt = document.createElement('option'); opt.value = p.id; opt.textContent = `${p.name} (${p.handle})`; sel.appendChild(opt); });
        composerProfileId = profiles.some(p => p.id === prefId) ? prefId : (profiles[0]?.id || null);
        if (composerProfileId) sel.value = composerProfileId;
    }

    function setComposerProfile(pid) { const p = profiles.find(x => x.id === pid); if (!p) return; composerProfileId = p.id; const sel = document.getElementById('postProfileSelect'); if (sel) sel.value = p.id; const av = document.getElementById('modalComposeAvatar'); if (av) setMediaElement(av, p.avatarThumb || p.avatarThumbPath || p.avatar || p.avatarPath); }
    function openPostModal(pid = null) { renderComposerProfileOptions(pid || composerProfileId || activeProfileId); setComposerProfile(composerProfileId); document.getElementById('postModal').style.display = 'flex'; requestAnimationFrame(resizePostTextarea); }
    function closePostModal() { 
        document.getElementById('postModal').style.display = 'none'; 
        selectedMediaFiles.forEach(m => { if(m.file && m.thumbnailUrl) URL.revokeObjectURL(m.thumbnailUrl); });
        clearPostForm(); 
    }
    function resizePostTextarea() { const ta = document.getElementById('postText'); if (!ta) return; if(ta.tagName === 'DIV') { ta.style.minHeight = '100px'; return; } ta.style.height = 'auto'; const st = window.getComputedStyle(ta); const min = parseFloat(st.minHeight)||100, max = parseFloat(st.maxHeight)||260, nxt = Math.max(min, Math.min(ta.scrollHeight, max)); ta.style.height = `${nxt}px`; ta.style.overflowY = ta.scrollHeight > max ? 'auto' : 'hidden'; }

    async function deleteProfile() {
        if (profiles.length <= 1) { alert('No puedes eliminar el único perfil.'); return; }
        if (confirm('¿Eliminar perfil, posts y multimedia asociada?')) {
            const dId = activeProfileId;
            let threadsToSave = [];
            
            for (let t of threadsData) {
                let postsToDelete = t.posts.filter(p => p.authorId === dId);
                for (let p of postsToDelete) {
                    for (let m of (p.media || [])) {
                        if (m.path) await deleteMediaFile(m.path);
                        if (m.thumbPath) await deleteMediaFile(m.thumbPath);
                        if (m.thumbnailUrl) URL.revokeObjectURL(m.thumbnailUrl);
                    }
                }
                t.posts = t.posts.filter(p => p.authorId !== dId);
                if (t.posts.length > 0) threadsToSave.push(t);
                else await deleteThreadFromFolder(t.id);
            }
            threadsData = threadsToSave;
            
            const dp = profiles.find(p => p.id === dId);
            if(dp) { if(dp.avatarPath) await deleteMediaFile(dp.avatarPath); if(dp.avatarThumbPath) await deleteMediaFile(dp.avatarThumbPath); if(dp.coverPath) await deleteMediaFile(dp.coverPath); if(dp.coverThumbPath) await deleteMediaFile(dp.coverThumbPath); }
            profiles = profiles.filter(p => p.id !== dId);
            await deleteProfileFromFolder(dId);
            
            for (let t of threadsData) await saveThreadToFolder(t);
            activeProfileId = profiles[0].id; composerProfileId = activeProfileId; await saveSettingsToFolder();
            if (window.activeThreadId && !threadsData.some(t => t.id === window.activeThreadId)) { window.activeThreadId = null; document.body.classList.remove('in-thread-view'); document.getElementById('threadHeader').style.display = 'none'; }
            closeEditModal(); renderCurrentProfileUI(); renderAllFeed(); switchTab(currentTab);
        }
    }

    function handleFloatingBtn(e) {
        if (document.body.classList.contains('in-thread-view')) { const aTh = document.querySelector('.active-thread'); if (aTh) { replyingToPost = aTh.querySelector('.post:first-child'); replyingToThread = aTh; document.getElementById('postText').dataset.placeholder = "Postea tu respuesta"; openPostModal(); return; } } openPostModal();
    }

    document.getElementById('postProfileSelect').addEventListener('change', function() { setComposerProfile(this.value); });
    document.getElementById('postText').addEventListener('input', resizePostTextarea);

    document.getElementById('postMedia').addEventListener('change', async function(e) {
        const files = Array.from(e.target.files); const hasVid = selectedMediaFiles.some(m => m.isVideo); let vidAcc = !hasVid; let sk = 0;
        for (const f of files) {
            const isVid = f.type.startsWith('video/'); if (isVid) { if (!vidAcc) { sk++; continue; } vidAcc = false; }
            const thumbBlob = await generateThumbnail(f);
            const thumbUrl = URL.createObjectURL(thumbBlob);
            selectedMediaFiles.push({ file: f, isVideo: isVid, thumbBlob: thumbBlob, thumbnailUrl: thumbUrl });
        }
        this.value = ''; if (sk > 0) alert('Máximo 1 video por post.'); renderMediaPreview();
    });

    function renderMediaPreview() {
        const c = document.getElementById('postMediaPreview'); c.innerHTML = ''; c.className = 'media-grid';
        if (selectedMediaFiles.length > 0) {
            if (selectedMediaFiles.length <= 4) { c.classList.add(`grid-${selectedMediaFiles.length}`); c.style.gridTemplateColumns = ''; c.style.gridAutoRows = ''; } 
            else { c.style.gridTemplateColumns = 'repeat(auto-fit, minmax(120px, 1fr))'; c.style.gridAutoRows = '120px'; }
            c.style.display = 'grid';
            selectedMediaFiles.forEach((m, i) => {
                const w = document.createElement('div'); w.className = 'media-preview-wrapper';
                const wrap = document.createElement('div'); wrap.className = 'media-item-wrap';
                const el = document.createElement('img'); el.src = m.thumbnailUrl; el.className = 'media-item';
                wrap.appendChild(el);
                if(m.isVideo) {
                    const vo = document.createElement('div'); vo.className = 'video-overlay';
                    vo.innerHTML = '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>';
                    wrap.appendChild(vo);
                }
                const rb = document.createElement('button'); rb.innerHTML = '&times;'; rb.className = 'remove-media-btn'; rb.onclick = e => { e.preventDefault(); const removed = selectedMediaFiles.splice(i, 1)[0]; if(removed.thumbnailUrl && removed.file) URL.revokeObjectURL(removed.thumbnailUrl); renderMediaPreview(); };
                w.appendChild(wrap); w.appendChild(rb); c.appendChild(w);
            });
        } else c.style.display = 'none';
    }

    async function openFullViewer(mediaArr, index) { 
        viewerImages = mediaArr; 
        currentViewerIndex = index; 
        document.getElementById('imageViewerModal').style.display = 'flex'; 
        await updateViewerMedia(); 
    }

    async function updateViewerMedia() {
        if (viewerImages.length === 0) return;
        const content = document.getElementById('imageViewerContent');

        if (content.children.length === 0) {
            activeFullUrls = [];
            for (let i = 0; i < viewerImages.length; i++) {
                const m = viewerImages[i];
                let fullUrl = '';
                if (m.file) { fullUrl = URL.createObjectURL(m.file); }
                else if (m.path) {
                    try {
                        const mediaDir = await folderHandle.getDirectoryHandle('media', {create: true});
                        fullUrl = await getMediaUrl(mediaDir, m.path);
                    } catch(e) {}
                }
                if (fullUrl) activeFullUrls.push(fullUrl);
                
                let el;
                if (m.isVideo) {
                    el = document.createElement('video');
                    el.src = fullUrl; el.controls = true;
                    el.style.maxWidth = '100%'; el.style.maxHeight = '90vh'; el.style.borderRadius = '8px';
                } else {
                    el = document.createElement('img');
                    el.className = 'viewer-full-image';
                    el.style.maxWidth = '100%'; el.style.maxHeight = '90vh'; el.style.objectFit = 'contain'; el.style.borderRadius = '8px';
                    if (fullUrl) el.src = fullUrl;
                    else setMediaElement(el, m.thumbnailUrl || m.thumbPath || m.path);
                }
                el.style.display = 'none';
                content.appendChild(el);
            }
        }

        Array.from(content.children).forEach((child, idx) => {
            child.style.display = (idx === currentViewerIndex) ? 'block' : 'none';
            if (child.tagName === 'VIDEO') {
                if (idx === currentViewerIndex) child.play().catch(()=>{});
                else child.pause();
            }
        });
    }

    function closeImageViewer() { 
        document.getElementById('imageViewerModal').style.display = 'none'; 
        viewerImages = []; 
        activeFullUrls.forEach(url => URL.revokeObjectURL(url));
        activeFullUrls = [];
        document.getElementById('imageViewerContent').innerHTML = '';
    }

    const vc = document.getElementById('imageViewerContent'); 
    vc.addEventListener('touchstart', e => { touchstartX = e.changedTouches[0].screenX; }, {passive: true}); 
    vc.addEventListener('touchend', e => { 
        touchendX = e.changedTouches[0].screenX; const st = 15; 
        if (touchendX < touchstartX - st && currentViewerIndex < viewerImages.length - 1) { currentViewerIndex++; updateViewerMedia(); } 
        if (touchendX > touchstartX + st && currentViewerIndex > 0) { currentViewerIndex--; updateViewerMedia(); } 
    }, {passive: true});

    async function saveProfile() {
        const nn = document.getElementById('editName').value.trim(); const nh = document.getElementById('editHandle').value.trim(); const nb = document.getElementById('editBio').value.trim();
        const pi = document.getElementById('editProfilePic'); const ci = document.getElementById('editCoverPic');
        const p = profiles.find(x => x.id === activeProfileId);
        if (nn) p.name = nn; if (nh) p.handle = formatUniqueHandle(nh, p.id); p.bio = nb;
        if (pi.files[0]) { if(p.avatarPath) await deleteMediaFile(p.avatarPath); if(p.avatarThumbPath) await deleteMediaFile(p.avatarThumbPath); p.avatarFile = pi.files[0]; p.avatar = URL.createObjectURL(pi.files[0]); p.avatarThumb = URL.createObjectURL(await generateThumbnail(pi.files[0])); }
        if (ci.files[0]) { if(p.coverPath) await deleteMediaFile(p.coverPath); if(p.coverThumbPath) await deleteMediaFile(p.coverThumbPath); p.coverFile = ci.files[0]; p.cover = URL.createObjectURL(ci.files[0]); p.coverThumb = URL.createObjectURL(await generateThumbnail(ci.files[0])); }
        await saveProfileToFolder(p); renderCurrentProfileUI(); if (currentTab === 'profile') renderProfileContent(); else renderAllFeed();
        pi.value = ''; ci.value = ''; closeEditModal();
    }

    function toggleDropdown(e, btn) { e.stopPropagation(); const dd = btn.nextElementSibling; const v = dd.style.display === 'block'; document.querySelectorAll('.post-dropdown').forEach(d => d.style.display = 'none'); dd.style.display = v ? 'none' : 'block'; }

    async function deletePost(e, btn) {
        e.stopPropagation();
        if (confirm('¿Eliminar este post?')) {
            const pEl = btn.closest('.post'); const tEl = pEl.closest('.thread-container, .profile-response-context'); if (!tEl) return;
            const tId = tEl.dataset.threadId; const pId = pEl.dataset.id;
            const tIdx = threadsData.findIndex(t => t.id === tId);
            if(tIdx > -1) {
                const t = threadsData[tIdx]; const pIdx = t.posts.findIndex(p => p.id === pId);
                if(pIdx > -1) {
                    const dPost = t.posts[pIdx]; 
                    for (let m of (dPost.media || [])) {
                        if (m.path) await deleteMediaFile(m.path);
                        if (m.thumbPath) await deleteMediaFile(m.thumbPath);
                        if (m.thumbnailUrl) URL.revokeObjectURL(m.thumbnailUrl);
                    }
                    t.posts.splice(pIdx, 1); if (pIdx > 0 && t.posts[pIdx - 1]) t.posts[pIdx - 1].replyCount = Math.max(0, (t.posts[pIdx - 1].replyCount || 0) - 1);
                }
                
                pEl.remove();
                if(t.posts.length === 0) { 
                    threadsData.splice(tIdx, 1); 
                    tEl.remove();
                    await deleteThreadFromFolder(t.id);
                    if(document.body.classList.contains('in-thread-view')) closeThreadView();
                } else {
                    await saveThreadToFolder(t);
                }
            }
        }
    }

    function editPost(e, btn) { e.stopPropagation(); editingPostElement = btn.closest('.post'); window.isAdvancedMode = editingPostElement.dataset.isAdvanced === 'true'; if (window.isAdvancedMode) { document.getElementById('postText').innerHTML = editingPostElement.dataset.rawText || ''; } else { document.getElementById('postText').innerText = editingPostElement.dataset.rawText || ''; } document.getElementById('rtToolbar').style.display = window.isAdvancedMode ? 'flex' : 'none'; requestAnimationFrame(resizePostTextarea); document.getElementById('postSubmitBtn').innerText = 'Guardar'; selectedMediaFiles = [...(editingPostElement.mediaData || [])]; renderMediaPreview(); openPostModal(editingPostElement.dataset.authorId || activeProfileId); }
    function startReply(btn, e) { e.stopPropagation(); replyingToPost = btn.closest('.post'); replyingToThread = btn.closest('.thread-container, .profile-response-context'); document.getElementById('postText').dataset.placeholder = "Postea tu respuesta"; openPostModal(); }
    function clearPostForm() { const ml = document.getElementById('mediaUploadLabel'); if(ml){ ml.style.opacity = '1'; ml.style.pointerEvents = 'auto'; } const mi = document.getElementById('postMedia'); if(mi) mi.disabled = false; document.getElementById('postText').innerHTML = ''; document.getElementById('postText').dataset.placeholder = "¡¿Qué está pasando?!"; window.isAdvancedMode = false; document.getElementById('rtToolbar').style.display = 'none'; requestAnimationFrame(resizePostTextarea); document.getElementById('postMedia').value = ''; document.getElementById('postSubmitBtn').innerText = 'Postear'; selectedMediaFiles = []; editingPostElement = null; replyingToThread = null; replyingToPost = null; composerProfileId = activeProfileId; renderComposerProfileOptions(composerProfileId); setComposerProfile(composerProfileId); renderMediaPreview(); }

    function buildMediaGridForPost(mArr) {
        const mg = document.createElement('div'); mg.className = 'media-grid';
        if (mArr.length <= 4) mg.classList.add(`grid-${mArr.length}`); else { mg.style.gridTemplateColumns = 'repeat(auto-fit, minmax(120px, 1fr))'; mg.style.gridAutoRows = '120px'; }
        const iUrls = mArr; 
        let idx = 0;
        mArr.forEach(m => {
            const w = document.createElement('div'); w.className = 'media-item-wrap';
            const el = document.createElement('img'); 
            const cIdx = idx++; el.onclick = e => { e.stopPropagation(); openFullViewer(iUrls, cIdx); };
            el.className = 'media-item'; 
            setMediaElement(el, m.thumbnailUrl || m.thumbPath || m.path);
            w.appendChild(el);
            if(m.isVideo) {
                const vo = document.createElement('div'); vo.className = 'video-overlay';
                vo.innerHTML = '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>';
                w.appendChild(vo);
            }
            mg.appendChild(w);
        }); return mg;
    }

    function renderPostContent(div, text, mArr) {
        const aId = div.dataset.authorId || activeProfileId; const ap = profiles.find(p => p.id === aId) || profiles[0]; if (!ap) return;
        const rc = div.dataset.replyCount || '0'; const rcHtml = rc !== '0' ? rc : '';
        div.innerHTML = `
            <div class="post-left-col"><div class="post-avatar sync-avatar profile-link" role="button" tabindex="0"></div><div class="thread-line"></div></div>
            <div class="post-main">
                <div class="post-header" style="justify-content: space-between; width: 100%;">
                    <div style="display: flex; gap: 4px; align-items: center;"><span class="post-author sync-name profile-link" role="button" tabindex="0">${escapeHtml(ap.name || 'Usuario')}</span><span class="post-handle sync-handle profile-link" role="button" tabindex="0">${escapeHtml(ap.handle || '@usuario')} · Ahora</span></div>
                    <div class="post-options" style="position: relative;"><button class="post-options-btn" onclick="toggleDropdown(event, this)">⋮</button><div class="post-dropdown"><div class="post-dropdown-item" onclick="editPost(event, this)">Editar</div><div class="post-dropdown-item danger" onclick="deletePost(event, this)">Eliminar</div></div></div>
                </div>
                ${text ? `<div class="post-content">${div.dataset.isAdvanced === 'true' ? text : renderTextWithHashtags(text)}</div>` : ''}
            </div>
        `;
        setMediaElement(div.querySelector('.post-avatar'), ap.avatarThumb || ap.avatarThumbPath || ap.avatar || ap.avatarPath);
        div.querySelectorAll('.profile-link').forEach(t => { const go = e => openProfile(aId, e); t.addEventListener('click', go); t.addEventListener('keydown', e => { if(e.key==='Enter'||e.key===' ') go(e); }); });
        const pm = div.querySelector('.post-main'); if (mArr && mArr.length > 0) pm.appendChild(buildMediaGridForPost(mArr));
        const act = document.createElement('div'); act.className = 'post-actions';
        act.innerHTML = `<button class="action-btn reply-btn" title="Responder" onclick="startReply(this, event)"><svg viewBox="0 0 24 24"><g><path d="M1.751 10c0-4.42 3.584-8 8.005-8h4.366c4.49 0 8.129 3.64 8.129 8.13 0 2.96-1.607 5.68-4.196 7.11l-8.054 4.46v-3.69h-.067c-4.49.1-8.183-3.51-8.183-8.01zm8.005-6c-3.317 0-6.005 2.69-6.005 6 0 3.37 2.77 6.08 6.138 6.01l.351-.01h1.761v2.3l5.087-2.81c1.951-1.08 3.163-3.13 3.163-5.36 0-3.39-2.744-6.13-6.129-6.13H9.756z"></path></g></svg><span class="reply-count-text">${rcHtml}</span></button>`;
        pm.appendChild(act);
    }

    async function submitPost() {
    const postBtn = document.getElementById('postSubmitBtn');
    if (postBtn && postBtn.disabled) return;
    if (postBtn) {
        postBtn.dataset.origText = postBtn.innerText;
        postBtn.innerText = 'Publicando...';
        postBtn.disabled = true;
    }
    try {
        const ptEl = document.getElementById('postText'); const text = window.isAdvancedMode ? ptEl.innerHTML.trim() : ptEl.innerText.trim(); const selId = profiles.some(p => p.id === composerProfileId) ? composerProfileId : activeProfileId;
        if (!selId || (!text && selectedMediaFiles.length === 0)) return;

        let threadToSave = null;

        if (editingPostElement) {
            const c = editingPostElement.closest('.thread-container, .profile-response-context'); if (!c) return;
            const t = threadsData.find(th => th.id === c.dataset.threadId);
            if(t) {
                const p = t.posts.find(po => po.id === editingPostElement.dataset.id);
                if(p) {
                    const toDelete = (p.media || []).filter(om => !selectedMediaFiles.some(nm => nm.path === om.path && om.path));
                    for (let rm of toDelete) {
                        if (rm.path) deleteMediaFile(rm.path);
                        if (rm.thumbPath) deleteMediaFile(rm.thumbPath);
                        if (rm.thumbnailUrl) URL.revokeObjectURL(rm.thumbnailUrl);
                    }
                    p.text = text; p.authorId = selId; p.isAdvanced = window.isAdvancedMode; p.media = [...selectedMediaFiles]; threadToSave = t;
                }
            }
        } else {
            const np = { id: 'post_' + Date.now(), text: text, authorId: selId, isAdvanced: window.isAdvancedMode, replyCount: 0, media: [...selectedMediaFiles] };
            if (replyingToThread) {
            const tIdx = threadsData.findIndex(th => th.id === replyingToThread.dataset.threadId);
            if (tIdx > -1) {
                const t = threadsData[tIdx];
                t.posts.push(np);
                if (replyingToPost) { const par = t.posts.find(p => p.id === replyingToPost.dataset.id); if (par) par.replyCount++; }
                threadToSave = t;
                
                // Mover el hilo al inicio del feed. Esto elimina el cuello de botella
                // del 'while (virtualFeedQueue.length > 0)' que congelaba la pestaña.
                threadsData.splice(tIdx, 1);
                threadsData.unshift(t);
            }
            } else { threadToSave = { id: 'thread_' + Date.now(), posts: [np] }; threadsData.unshift(threadToSave); }
        }

        if (currentTab === 'search' && !document.body.classList.contains('in-thread-view')) renderSearchResults(document.getElementById('searchInput').value);
        else if (currentTab === 'profile' && !document.body.classList.contains('in-thread-view')) renderProfileContent(); 
        else renderAllFeed();
        
        if (replyingToThread && !document.body.classList.contains('in-thread-view')) {
             const tId = replyingToThread.dataset.threadId; setTimeout(() => { 
                while (virtualFeedQueue.length > 0 && !document.querySelector(`.thread-container[data-thread-id="${tId}"]`)) {
                    renderVirtualBatch();
                }
                const uc = document.querySelector(`.thread-container[data-thread-id="${tId}"]`); 
                if(uc) { 
                    if (uc.virtualNodeStorage) { uc.style.minHeight = ''; uc.appendChild(uc.virtualNodeStorage); uc.virtualNodeStorage = null; uc.dataset.virtualized = 'false'; }
                    const fp = uc.querySelector('.post'); if(fp) viewThread(fp, {target: fp}); 
                } 
            }, 0);
        }

        if (threadToSave) await saveThreadToFolder(threadToSave);

        selectedMediaFiles = [];
        document.getElementById('postModal').style.display = 'none';
        clearPostForm();
    } finally {
        const postBtn = document.getElementById('postSubmitBtn');
        if (postBtn) {
            postBtn.innerText = postBtn.dataset.origText || 'Postear';
            postBtn.disabled = false;
        }
    }
}
    
    const sInput = document.getElementById('searchInput');
    let searchTimeout; sInput.addEventListener('input', function() { clearTimeout(searchTimeout); searchTimeout = setTimeout(() => { if (currentTab === 'search') renderSearchResults(this.value); }, 300); });
    sInput.addEventListener('keydown', function(e) { if (e.key === 'Enter') { e.preventDefault(); renderSearchResults(this.value); } });

    async function initializeApp() {
        showStartupOverlay('Selecciona una carpeta para comenzar.');
        try {
            const sHandle = await getStoredFolderHandle();
            if (!sHandle) { updateStorageStatus('Ninguna'); return; }
            if (await ensureFolderPermission(sHandle, false)) { await activateFolder(sHandle); return; }
            showStartupOverlay(`Puedes volver a usar la carpeta guardada "${sHandle.name}" o seleccionar otra.`, sHandle);
        } catch (e) { updateStorageStatus('Ninguna'); showStartupOverlay('Selecciona una carpeta para comenzar.'); }
    }

    initializeApp();


window.isAdvancedMode = false;
function toggleAdvancedMode() {
    window.isAdvancedMode = !window.isAdvancedMode;
    document.getElementById('rtToolbar').style.display = window.isAdvancedMode ? 'flex' : 'none';
    const pt = document.getElementById('postText');
    const mediaLbl = document.getElementById('mediaUploadLabel');
    const mediaInp = document.getElementById('postMedia');
    if (window.isAdvancedMode) {
        pt.focus();
        syncCmdState();
        if(mediaLbl) { mediaLbl.style.opacity = '0.4'; mediaLbl.style.pointerEvents = 'none'; }
        if(mediaInp) mediaInp.disabled = true;
    } else {
        pt.innerText = pt.innerText;
        if(mediaLbl) { mediaLbl.style.opacity = '1'; mediaLbl.style.pointerEvents = 'auto'; }
        if(mediaInp) mediaInp.disabled = false;
    }
}

window.execCmd = function(cmd) {
    document.execCommand(cmd, false, null);
    syncCmdState();
    const pt = document.getElementById('postText');
    if(pt) pt.focus();
};

window.syncCmdState = function() {
    if (!window.isAdvancedMode) return;
    document.querySelectorAll('.rt-btn[data-cmd]').forEach(btn => {
        const cmd = btn.dataset.cmd;
        if (document.queryCommandState(cmd)) {
            btn.classList.add('active');
        } else {
            btn.classList.remove('active');
        }
    });
};

const _pt = document.getElementById('postText');
if (_pt) {
    _pt.addEventListener('keyup', syncCmdState);
    _pt.addEventListener('mouseup', syncCmdState);
    _pt.addEventListener('touchend', syncCmdState);
    _pt.addEventListener('input', syncCmdState);
    _pt.addEventListener('paste', function(e) {
        e.preventDefault();
        const text = (e.originalEvent || e).clipboardData.getData('text/plain');
        document.execCommand('insertText', false, text);
    });
}

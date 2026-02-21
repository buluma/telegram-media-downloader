// Utility Functions

export function formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const dm = 2;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

export function formatDate(dateStr) {
    if (!dateStr) return '';
    return new Date(dateStr).toLocaleString();
}

export function escapeHtml(text) {
    if (!text) return '';
    return text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

export function getFileIcon(ext) {
    const map = {
        mp4: 'ri-video-line', mkv: 'ri-video-line', avi: 'ri-video-line', mov: 'ri-video-line', webm: 'ri-video-line',
        mp3: 'ri-music-line', flac: 'ri-music-line', wav: 'ri-music-line', ogg: 'ri-music-line', aac: 'ri-music-line',
        jpg: 'ri-image-line', jpeg: 'ri-image-line', png: 'ri-image-line', gif: 'ri-image-line', webp: 'ri-image-line', bmp: 'ri-image-line',
        pdf: 'ri-file-pdf-line', doc: 'ri-file-word-line', docx: 'ri-file-word-line',
        zip: 'ri-file-zip-line', rar: 'ri-file-zip-line', '7z': 'ri-file-zip-line',
        txt: 'ri-file-text-line', json: 'ri-file-code-line', js: 'ri-file-code-line',
    };
    return map[(ext || '').toLowerCase().replace('.', '')] || 'ri-file-line';
}

export function getGroupType(id) {
    const idStr = String(id);
    if (!idStr.startsWith('-')) return 'Private Chat';
    if (idStr.startsWith('-100')) return 'Channel';
    return 'Group';
}

export function getAvatarClass(id) {
    const colors = [
        'bg-gradient-to-br from-red-500 to-orange-500', 
        'bg-gradient-to-br from-orange-400 to-yellow-500',
        'bg-gradient-to-br from-purple-500 to-pink-500',
        'bg-gradient-to-br from-blue-500 to-cyan-500',
        'bg-gradient-to-br from-green-400 to-emerald-600',
        'bg-gradient-to-br from-indigo-500 to-purple-600',
        'bg-gradient-to-br from-pink-500 to-rose-500',
        'bg-gradient-to-br from-cyan-500 to-blue-600'
    ];
    const numId = Math.abs(parseInt(String(id).slice(-5)) || 0);
    return colors[numId % colors.length];
}

export function createAvatar(id, name, type) {
    const gradient = getAvatarClass(id);
    const initial = (name || '?').charAt(0).toUpperCase();
    let typeIcon = 'question-line';
    
    if (type === 'channel' || String(id).startsWith('-100')) typeIcon = 'megaphone-fill';
    else if (type === 'group' || String(id).startsWith('-')) typeIcon = 'group-fill';
    else typeIcon = 'user-fill';

    return `
        <div class="relative w-12 h-12 flex-shrink-0">
            <img src="/api/groups/${id}/photo" 
                 class="w-full h-full rounded-full object-cover bg-tg-bg border border-white/5" 
                 onerror="this.style.display='none'; this.nextElementSibling.style.display='flex'"
                 loading="lazy"
                 alt="${escapeHtml(name)}">
            
            <div class="absolute inset-0 w-full h-full rounded-full ${gradient} flex items-center justify-center text-white hidden shadow-inner">
                <span class="text-xl font-bold drop-shadow-md pb-0.5">${initial}</span>
            </div>

            <div class="absolute -bottom-0.5 -right-0.5 w-5 h-5 rounded-full bg-tg-panel flex items-center justify-center z-10 border border-tg-bg">
                <div class="w-4 h-4 rounded-full bg-tg-bg flex items-center justify-center text-tg-textSecondary text-[10px]">
                    <i class="ri-${typeIcon}"></i>
                </div>
            </div>
        </div>
    `;
}

export function showToast(message, type = 'info') {
    // Basic toast implementation
    const toast = document.createElement('div');
    toast.className = `fixed bottom-4 left-1/2 -translate-x-1/2 px-4 py-2 rounded-lg shadow-lg z-[100] transition-opacity duration-300 ${
        type === 'error' ? 'bg-tg-red text-white' : 'bg-tg-blue text-white'
    }`;
    toast.textContent = message;
    document.body.appendChild(toast);
    
    setTimeout(() => {
        toast.style.opacity = '0';
        setTimeout(() => toast.remove(), 300);
    }, 3000);
}

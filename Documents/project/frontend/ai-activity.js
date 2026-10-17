// Small ClimbAI loops live beside the answer that is being prepared, never over
// the whole app. The poster remains visible when autoplay is unavailable.
const AIActivity = (() => {
  const MEDIA = {
    thinking: {
      video: 'media/climbai-thinking.webm',
      poster: 'media/climbai-thinking-poster.jpg',
    },
    reading: {
      video: 'media/climbai-reading.webm',
      poster: 'media/climbai-reading-poster.jpg',
    },
  };

  function create(kind, label, compact = false) {
    const media = MEDIA[kind];
    if (!media) throw new TypeError(`Unknown ClimbAI activity: ${kind}`);

    const activity = document.createElement('div');
    activity.className = 'ai-activity' + (compact ? ' ai-activity--compact' : '');

    const artwork = document.createElement('span');
    artwork.className = 'ai-activity-artwork';
    artwork.setAttribute('aria-hidden', 'true');

    const poster = document.createElement('img');
    poster.className = 'ai-activity-poster';
    poster.src = media.poster;
    poster.alt = '';

    artwork.appendChild(poster);
    if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      const video = document.createElement('video');
      video.className = 'ai-activity-video';
      video.src = media.video;
      video.poster = media.poster;
      video.muted = true;
      video.loop = true;
      video.autoplay = true;
      video.playsInline = true;
      video.preload = 'metadata';
      video.setAttribute('aria-hidden', 'true');
      video.addEventListener('playing', () => artwork.classList.add('is-playing'), { once: true });
      artwork.appendChild(video);
      video.play().catch(() => {
        // The still poster remains in place if the browser blocks autoplay.
      });
    }
    const text = document.createElement('span');
    text.className = 'ai-activity-label';
    text.textContent = label;
    activity.append(artwork, text);
    return activity;
  }

  return { create };
})();

window.AIActivity = AIActivity;

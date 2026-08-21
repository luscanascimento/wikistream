import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { DatePipe, DecimalPipe } from '@angular/common';
import { ScrollingModule } from '@angular/cdk/scrolling';
import { SIZE_BUCKETS, type TopEntry } from './aggregate';
import { Feed, PENDING_MAX, RETAIN, type AgentFilter, type FeedItem } from './feed';
import { WikiStream } from './wiki-stream';

/** `light dark` follows the operating system; the others pin it. */
type Theme = 'light dark' | 'light' | 'dark';

const THEMES: readonly Theme[] = ['light dark', 'light', 'dark'];
const THEME_LABELS: Record<Theme, string> = {
  'light dark': 'Theme: system',
  light: 'Theme: light',
  dark: 'Theme: dark',
};

/** Multipliers for the synthetic load control. */
const STRESS_STEPS = [1, 10, 50, 100, 250] as const;

interface Bar extends TopEntry {
  readonly pct: number;
}

function bars(entries: readonly TopEntry[]): Bar[] {
  const max = Math.max(1, ...entries.map((e) => e.count));
  return entries.map((e) => ({ ...e, pct: (e.count / max) * 100 }));
}

@Component({
  selector: 'app-root',
  imports: [DecimalPipe, DatePipe, ScrollingModule],
  templateUrl: './app.html',
  styleUrl: './app.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class App {
  protected readonly stream = inject(WikiStream);
  protected readonly feed = inject(Feed);

  protected readonly retain = RETAIN;
  protected readonly pendingMax = PENDING_MAX;
  protected readonly stressSteps = STRESS_STEPS;
  protected readonly agentOptions: readonly AgentFilter[] = ['all', 'human', 'bot'];

  protected readonly theme = signal<Theme>('light dark');
  protected readonly themeLabel = computed(() => THEME_LABELS[this.theme()]);

  constructor() {
    // Set on the root element rather than the host so the page beyond the app's
    // own box — scrollbars, overscroll — follows the same scheme.
    effect(() => {
      document.documentElement.style.colorScheme = this.theme();
    });
  }

  protected cycleTheme(): void {
    this.theme.set(THEMES[(THEMES.indexOf(this.theme()) + 1) % THEMES.length] ?? 'light dark');
  }

  protected readonly wikiBars = computed(() => bars(this.feed.stats()?.topWikis ?? []));

  protected readonly sizeBars = computed(() => {
    const counts = this.feed.stats()?.sizeBuckets ?? [];
    const max = Math.max(1, ...counts);
    return SIZE_BUCKETS.map((label, i) => ({
      label,
      count: counts[i] ?? 0,
      pct: ((counts[i] ?? 0) / max) * 100,
    }));
  });

  protected readonly botShare = computed(() => {
    const stats = this.feed.stats();
    return stats && stats.total > 0 ? (stats.bots / stats.total) * 100 : 0;
  });

  /** Keeps the current selection listed even after it drops out of the top wikis. */
  protected readonly wikiOptions = computed(() => {
    const top = (this.feed.stats()?.topWikis ?? []).map((w) => w.key);
    const current = this.feed.wiki();
    return current !== '' && !top.includes(current) ? [current, ...top] : top;
  });

  /** Rate history as an SVG polyline over a 100x30 viewBox. */
  protected readonly spark = computed(() => {
    const series = this.feed.stats()?.perSecond ?? [];
    if (series.length < 2) return '';
    const max = Math.max(1, ...series);
    const step = 100 / (series.length - 1);
    return series
      .map((v, i) => `${(i * step).toFixed(2)},${(29 - (v / max) * 28).toFixed(2)}`)
      .join(' ');
  });

  protected trackSeq(_index: number, item: FeedItem): number {
    return item.seq;
  }

  protected togglePause(): void {
    this.feed.paused.update((paused) => !paused);
  }

  protected setBackpressure(event: Event): void {
    this.feed.backpressure.set((event.target as HTMLInputElement).checked);
  }

  protected setStress(event: Event): void {
    this.feed.stress.set(Number((event.target as HTMLSelectElement).value));
  }

  protected setWiki(event: Event): void {
    this.feed.wiki.set((event.target as HTMLSelectElement).value);
  }

  protected setAgents(value: AgentFilter): void {
    this.feed.agents.set(value);
  }

  protected clearFilters(): void {
    this.feed.wiki.set('');
    this.feed.agents.set('all');
  }
}

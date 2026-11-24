<script lang="ts" module>
// Stroke paths on a 24-unit grid, drawn after Lucide (ISC licence).
const paths = {
  home: ["m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z", "M9 22V12h6v10"],
  chat: ["M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"],
  bag: [
    "M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4Z",
    "M3 6h18",
    "M16 10a4 4 0 0 1-8 0",
  ],
  box: [
    "M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z",
    "m3.3 7 8.7 5 8.7-5",
    "M12 22V12",
  ],
  activity: ["M22 12h-4l-3 9L9 3l-3 9H2"],
  chart: ["M3 3v18h18", "M18 17V9", "M13 17V5", "M8 17v-3"],
  sliders: [
    "M21 4h-7",
    "M10 4H3",
    "M21 12h-9",
    "M8 12H3",
    "M21 20h-5",
    "M12 20H3",
    "M14 2v4",
    "M8 10v4",
    "M16 18v4",
  ],
  building: [
    "M6 22V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v18Z",
    "M6 12H4a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h2",
    "M18 9h2a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-2",
    "M10 6h4",
    "M10 10h4",
    "M10 14h4",
    "M10 18h4",
  ],
  card: [
    "M4 5h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z",
    "M2 10h20",
  ],
  logout: [
    "M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4",
    "m16 17 5-5-5-5",
    "M21 12H9",
  ],
  menu: ["M4 6h16", "M4 12h16", "M4 18h16"],
  close: ["M18 6 6 18", "m6 6 12 12"],
  check: ["M20 6 9 17l-5-5"],
  arrow: ["M5 12h14", "m12 5 7 7-7 7"],
  plus: ["M5 12h14", "M12 5v14"],
  trash: [
    "M3 6h18",
    "M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6",
    "M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2",
  ],
  pencil: ["M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"],
  users: [
    "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2",
    "M13 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0",
    "M22 21v-2a4 4 0 0 0-3-3.87",
    "M16 3.13a4 4 0 0 1 0 7.75",
  ],
  user: [
    "M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2",
    "M16 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0",
  ],
  truck: [
    "M14 18V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v11a1 1 0 0 0 1 1h2",
    "M15 18H9",
    "M19 18h2a1 1 0 0 0 1-1v-3.65a1 1 0 0 0-.22-.62l-3.48-4.35A1 1 0 0 0 17.52 8H14",
    "M19 18a2 2 0 1 1-4 0 2 2 0 0 1 4 0",
    "M9 18a2 2 0 1 1-4 0 2 2 0 0 1 4 0",
  ],
  warehouse: [
    "M22 8.35V20a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V8.35A2 2 0 0 1 3.26 6.5l8-3.2a2 2 0 0 1 1.48 0l8 3.2A2 2 0 0 1 22 8.35Z",
    "M6 18h12",
    "M6 14h12",
    "M6 10h12",
  ],
  bot: [
    "M12 8V4H8",
    "M6 8h12a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2Z",
    "M2 14h2",
    "M20 14h2",
    "M15 13v2",
    "M9 13v2",
  ],
  megaphone: ["m3 11 18-5v12L3 14v-3z", "M11.6 16.8a3 3 0 1 1-5.8-1.6"],
  help: [
    "M2 12a10 10 0 1 0 20 0a10 10 0 1 0-20 0",
    "M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3",
    "M12 17h.01",
  ],
} as const;

export type IconName = keyof typeof paths;
</script>

<script lang="ts">
type Props = { name: IconName; class?: string };

let { name, class: className = "size-4" }: Props = $props();
</script>

<svg
	class="shrink-0 {className}"
	viewBox="0 0 24 24"
	fill="none"
	stroke="currentColor"
	stroke-width="1.75"
	stroke-linecap="round"
	stroke-linejoin="round"
	aria-hidden="true"
>
	{#each paths[name] as d}<path {d} />{/each}
</svg>

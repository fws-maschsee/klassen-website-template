/** @type {import('tailwindcss').Config} */
export default {
	content: [
		'./src/**/*.{astro,html,js,jsx,md,mdx,ts,tsx}',
		'./src/content/docs/**/*.md',
		'./src/content/blog/**/*.md',
		'node_modules/@levino/shipyard-*/**/*.{astro,js,ts}',
	],
	plugins: [require('@tailwindcss/typography'), require('daisyui')],
}

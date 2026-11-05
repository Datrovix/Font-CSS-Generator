// Font tasks: convert source fonts to woff2 and generate the styles file
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { woff2, ttftowoff2, woff2ttf, toArrayBuffer, toBuffer } from 'fonteditor-core'
import { fonts } from '../../project.config.js'

// Paths (relative to the project root)
const rootDir = path.resolve(import.meta.dirname, '..', '..')
const srcDir = path.resolve(rootDir, fonts.src)
const destDir = path.resolve(rootDir, fonts.dest)
const cssFile = path.resolve(rootDir, fonts.css)

// Extensions to convert and to copy as is
const convertExtensions = ['.ttf', '.otf', '.woff']
const copyExtensions = ['.woff2']

// Recognized font weight tokens (case-insensitive)
const weightMap = {
	thin: 100,
	hairline: 100,
	extralight: 200,
	ultralight: 200,
	light: 300,
	normal: 400,
	regular: 400,
	medium: 500,
	semibold: 600,
	demibold: 600,
	bold: 700,
	extrabold: 800,
	ultrabold: 800,
	black: 900,
	heavy: 900,
	extrablack: 950,
	ultrablack: 950
}

// Replace spaces in file names with hyphens
const sanitizeName = (name) => name.replace(/\s+/g, '-')
const toPosixPath = (value) => value.replace(/\\/g, '/')

const formatSize = (bytes) => `${Math.round(bytes / 1024)} KB`

// Parse a name like "Family-Weight-Italic" / "Family-BoldItalic" / "Family-Variable".
// Tokens are matched from right to left; unrecognized parts stay in the family name.
function parseFontName(baseName) {
	const parts = baseName.split('-')
	let weight = 400
	let style = 'normal'

	while (parts.length > 1) {
		const last = parts[parts.length - 1].toLowerCase()

		if (last === 'italic') {
			style = 'italic'
			parts.pop()
			continue
		}

		// variable font marker: "Roboto-Italic-Variable"
		if (last === 'variable') {
			parts.pop()
			continue
		}

		// combined token: "BoldItalic", "ExtraLightItalic"
		if (last.length > 6 && last.endsWith('italic')) {
			const weightPart = last.slice(0, -6)
			if (weightMap[weightPart]) {
				style = 'italic'
				weight = weightMap[weightPart]
				parts.pop()
				continue
			}
		}

		if (weightMap[last]) {
			weight = weightMap[last]
			parts.pop()
			continue
		}

		break
	}

	return { family: parts.join(' '), weight, style }
}

// Read the sfnt table directory (tag -> offset/length) from a raw sfnt buffer
function getSfntTables(buffer) {
	const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength)
	const numTables = view.getUint16(4)
	const tables = {}
	for (let i = 0; i < numTables; i++) {
		const entry = 12 + i * 16
		const tag = String.fromCharCode(
			view.getUint8(entry), view.getUint8(entry + 1),
			view.getUint8(entry + 2), view.getUint8(entry + 3)
		)
		tables[tag] = { offset: view.getUint32(entry + 8), length: view.getUint32(entry + 12) }
	}
	return tables
}

// Parse the fvar table and return variable axes, or null for a static font.
// Each axis: { tag, min, default, max }
function getVariableAxes(sfntBuffer) {
	const fvar = getSfntTables(sfntBuffer).fvar
	if (!fvar) return null
	const view = new DataView(sfntBuffer.buffer, sfntBuffer.byteOffset, sfntBuffer.byteLength)
	const count = view.getUint16(fvar.offset + 8)
	const size = view.getUint16(fvar.offset + 10)
	const axes = []
	for (let i = 0; i < count; i++) {
		const record = fvar.offset + 16 + i * size
		axes.push({
			tag: String.fromCharCode(
				view.getUint8(record), view.getUint8(record + 1),
				view.getUint8(record + 2), view.getUint8(record + 3)
			),
			min: view.getInt32(record + 4) / 65536,
			default: view.getInt32(record + 8) / 65536,
			max: view.getInt32(record + 12) / 65536
		})
	}
	return axes
}

// Remove font files directly inside dest (subfolders untouched),
// so dest always mirrors the current src contents
function cleanDestDir() {
	if (path.resolve(destDir) === path.resolve(srcDir) || !fs.existsSync(destDir)) return
	const extensions = [...convertExtensions, ...copyExtensions]
	const stale = fs.readdirSync(destDir, { withFileTypes: true })
		.filter((entry) => entry.isFile() && extensions.includes(path.extname(entry.name).toLowerCase()))
		.map((entry) => entry.name)
	for (const file of stale) {
		fs.rmSync(path.join(destDir, file))
	}
	if (stale.length) {
		console.log(`- ${stale.length} old font file(s) removed from ${path.relative(rootDir, destDir)}`)
	}
}

// Convert/copy fonts from src to dest
async function convertFonts() {
	if (!fs.existsSync(srcDir)) {
		console.log(`Source folder not found: ${path.relative(rootDir, srcDir)} — skipping`)
		return
	}

	fs.mkdirSync(destDir, { recursive: true })

	// Drop previously built fonts before rebuilding
	if (fonts.cleanDest) {
		cleanDestDir()
	}

	const files = fs.readdirSync(srcDir).filter((file) => {
		const ext = path.extname(file).toLowerCase()
		return convertExtensions.includes(ext) || copyExtensions.includes(ext)
	})

	if (!files.length) {
		console.log(`No fonts (.ttf, .otf, .woff, .woff2) found in ${path.relative(rootDir, srcDir)}`)
		return
	}

	await woff2.init()

	let converted = 0
	let copied = 0
	let failed = 0

	for (const file of files) {
		const ext = path.extname(file).toLowerCase()
		const srcFile = path.join(srcDir, file)
		const destFile = path.join(destDir, sanitizeName(path.basename(file, ext)) + '.woff2')

		try {
			// Ready woff2 files are just copied
			if (ext === '.woff2') {
				fs.copyFileSync(srcFile, destFile)
				copied++
				console.log(`✓ ${file} — copied`)
				continue
			}

			// Compress the raw sfnt buffer so every table stays intact
			// (variable axes, kerning, hinting — the object-based writer drops them)
			const buffer = fs.readFileSync(srcFile)
			let sfntBuffer = toArrayBuffer(buffer)
			// woff is a compressed sfnt container, extract tables first
			if (ext === '.woff') {
				sfntBuffer = woff2ttf(sfntBuffer, { inflate: (data) => zlib.inflateSync(Buffer.from(data)) })
			}
			const result = toBuffer(ttftowoff2(sfntBuffer))
			fs.writeFileSync(destFile, result)

			converted++
			console.log(`✓ ${file} → ${path.basename(destFile)} (${formatSize(buffer.length)} → ${formatSize(result.length)})`)

			// Remove the source file if configured
			if (!fonts.keepSource) {
				fs.rmSync(srcFile)
			}
		} catch (error) {
			failed++
			console.error(`✗ ${file}: ${error.message}`)
		}
	}

	console.log(`\nDone: ${converted} converted, ${copied} copied, ${failed} failed`)
	if (failed) {
		process.exitCode = 1
	}
}

// Generate the styles file with @font-face rules for every woff2 in dest
async function generateStyles() {
	if (!fs.existsSync(destDir)) {
		console.log(`Fonts folder not found: ${path.relative(rootDir, destDir)} — skipping styles`)
		return
	}

	const files = fs.readdirSync(destDir).filter((file) => file.toLowerCase().endsWith('.woff2'))

	fs.mkdirSync(path.dirname(cssFile), { recursive: true })

	if (!files.length) {
		fs.writeFileSync(cssFile, '/* No fonts found */\n')
		console.log(`No woff2 files in ${path.relative(rootDir, destDir)} — ${path.relative(rootDir, cssFile)} is empty`)
		return
	}

	await woff2.init()

	// url() prefix: from config or computed relative to the css file
	const urlBase = fonts.cssUrl || toPosixPath(path.relative(path.dirname(cssFile), destDir))

	const faces = files.map((file) => {
		const baseName = path.basename(file, path.extname(file))
		let axes = null
		try {
			const raw = fs.readFileSync(path.join(destDir, file))
			// decode woff2 to raw sfnt to read the fvar axis table
			axes = getVariableAxes(Buffer.from(woff2.decode(raw)))
		} catch (error) {
			console.error(`✗ ${file}: axes detection failed (${error.message})`)
		}
		return {
			file,
			...parseFontName(baseName),
			wght: axes?.find((axis) => axis.tag === 'wght'),
			wdth: axes?.find((axis) => axis.tag === 'wdth')
		}
	})

	const weightOf = (face) => (face.wght ? Math.round(face.wght.min) : face.weight)

	const sorted = faces.sort((a, b) => a.family.localeCompare(b.family) || weightOf(a) - weightOf(b) || a.style.localeCompare(b.style))

	const rules = sorted.map((face) => {
		const url = `${urlBase ? urlBase + '/' : ''}${face.file}`
		const lines = [
			'@font-face {',
			`	font-family: "${face.family}";`,
			`	font-display: ${fonts.fontDisplay};`,
			`	src: url("${url}") format("woff2");`,
		]
		if (face.wght && face.wght.min !== face.wght.max) {
			lines.push(`	font-weight: ${Math.round(face.wght.min)} ${Math.round(face.wght.max)};`)
		} else {
			lines.push(`	font-weight: ${face.weight};`)
		}
		if (face.wdth && face.wdth.min !== face.wdth.max) {
			lines.push(`	font-stretch: ${Math.round(face.wdth.min)}% ${Math.round(face.wdth.max)}%;`)
		}
		lines.push(`	font-style: ${face.style};`, '}')
		return lines.join('\n')
	})

	const variableCount = faces.filter((face) => face.wght || face.wdth).length

	const content = `/* Generated by tools/fonts/fonts.js — do not edit manually */\n\n${rules.join('\n')}\n`
	fs.writeFileSync(cssFile, content)
	console.log(`✓ styles — ${path.relative(rootDir, cssFile)} (${faces.length} faces${variableCount ? `, ${variableCount} variable` : ''})`)
}

// Convert a font base name into a valid JS identifier: "Roboto-Variable" -> "RobotoVariable"
function toIdentifier(baseName) {
	const id = baseName
		.split(/[^a-zA-Z0-9]+/)
		.filter(Boolean)
		.map((part) => part[0].toUpperCase() + part.slice(1))
		.join('')
	return /^[a-zA-Z]/.test(id) ? id : `Font${id}`
}

// Render the preload template: expand every {{#tags}}...{{/tags}} block
// with the per-font variables: {{url}} {{file}} {{name}} {{var}} {{path}}
function renderPreloadTemplate(template, faces) {
	return template.replace(/\{\{#tags\}\}([\s\S]*?)\{\{\/tags\}\}/g, (_block, chunk) =>
		faces
			.map((face) => chunk.replace(/\{\{(\w+)\}\}/g, (_match, key) => (key in face ? String(face[key]) : '')))
			.join('')
	)
}

// Generate the preload fragment with <link rel="preload"> tags
function generatePreload() {
	const preload = fonts.preload
	if (!preload?.enable) return

	if (!fs.existsSync(destDir)) {
		console.log(`Fonts folder not found: ${path.relative(rootDir, destDir)} — skipping preload`)
		return
	}

	const files = fs.readdirSync(destDir).filter((file) => file.toLowerCase().endsWith('.woff2'))
	const baseName = (file) => path.basename(file, path.extname(file)).toLowerCase()

	let selected
	if (preload.files === 'all') {
		selected = files
	} else {
		const wanted = preload.files.map((name) => String(name).replace(/\.woff2$/i, '').toLowerCase())
		const missing = new Set(wanted)
		// keep the config order: the most important fonts come first
		selected = wanted
			.map((name) => files.find((file) => baseName(file) === name))
			.filter((file) => {
				if (!file) return false
				missing.delete(baseName(file))
				return true
			})
		for (const name of missing) {
			console.error(`✗ preload: font not found — ${name}.woff2`)
		}
	}

	const outFile = path.resolve(rootDir, preload.out)
	fs.mkdirSync(path.dirname(outFile), { recursive: true })

	const urlBase = (preload.url || `/${toPosixPath(path.relative(rootDir, destDir))}`).replace(/\/+$/, '')

	const used = new Map()
	const uniqueId = (base) => {
		const count = used.get(base) || 0
		used.set(base, count + 1)
		return count === 0 ? base : `${base}${count + 1}`
	}

	const faces = selected.map((file) => {
		const name = path.basename(file, path.extname(file))
		// relative path from the output file to the font file, for import statements
		const rel = toPosixPath(path.relative(path.dirname(outFile), path.join(destDir, file)))
		return {
			file,
			name,
			url: `${urlBase}/${file}`,
			var: uniqueId(toIdentifier(name)),
			path: /^\.\.?\//.test(rel) ? rel : `./${rel}`,
		}
	})

	let template =
		'<!-- Generated by tools/fonts/fonts.js — do not edit manually -->\n' +
		'{{#tags}}<link rel="preload" href="{{url}}" as="font" type="font/woff2" crossorigin>\n{{/tags}}'
	if (preload.template) {
		// short names resolve to bundled templates: 'astro' -> tools/fonts/templates/preload.astro.tpl
		const templateFile =
			preload.template.includes('/') || preload.template.includes('\\') || preload.template.endsWith('.tpl')
				? path.resolve(rootDir, preload.template)
				: path.resolve(import.meta.dirname, 'templates', `preload.${preload.template}.tpl`)
		if (!fs.existsSync(templateFile)) {
			console.error(`✗ preload: template not found — ${path.relative(rootDir, templateFile)}`)
			return
		}
		template = fs.readFileSync(templateFile, 'utf8')
	}

	const rendered = renderPreloadTemplate(template, faces)
	const content = rendered.endsWith('\n') ? rendered : `${rendered}\n`
	fs.writeFileSync(outFile, content)
	console.log(`✓ preload — ${path.relative(rootDir, outFile)} (${selected.length} tags)`)
}

// Tasks (toggled in project.config.js)
if (fonts.convert) {
	await convertFonts()
} else {
	console.log('- conversion disabled in config')
}

if (fonts.generateCss) {
	await generateStyles()
} else {
	console.log('- css generation disabled in config')
}

generatePreload()

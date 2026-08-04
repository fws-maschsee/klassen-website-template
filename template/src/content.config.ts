import { defineCollection } from 'astro:content'
import { blogSchema } from '@levino/shipyard-blog'
import { createDocsCollection } from '@levino/shipyard-docs'
import { glob } from 'astro/loaders'

const docs = defineCollection(createDocsCollection('./src/content/docs'))

const blog = defineCollection({
	schema: blogSchema,
	loader: glob({ pattern: '**/*.md', base: './src/content/blog' }),
})

export const collections = { docs, blog }

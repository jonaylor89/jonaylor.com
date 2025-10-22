import { NextResponse } from 'next/server'
import fs from 'fs'
import path from 'path'

const postsDirectory = path.join(process.cwd(), 'content/posts')

export async function GET(
  request: Request,
  context: { params: Promise<{ slug: string }> }
) {
  const { slug } = await context.params

  try {
    // Try .mdx first, then .md
    let fullPath = path.join(postsDirectory, `${slug}.mdx`)
    let fileContents: string
    let extension = 'mdx'

    try {
      fileContents = fs.readFileSync(fullPath, 'utf8')
    } catch {
      // Try .md if .mdx doesn't exist
      fullPath = path.join(postsDirectory, `${slug}.md`)
      fileContents = fs.readFileSync(fullPath, 'utf8')
      extension = 'md'
    }

    // Return raw content with proper content type
    return new NextResponse(fileContents, {
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Content-Disposition': `inline; filename="${slug}.${extension}"`,
      },
    })
  } catch (error) {
    console.error('Error reading post:', error)
    return NextResponse.json(
      { error: 'Post not found' },
      { status: 404 }
    )
  }
}

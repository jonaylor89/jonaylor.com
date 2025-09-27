import Image from 'next/image'

interface BlogImageProps {
  src: string
  alt: string
  width?: number
  height?: number
  caption?: string
  className?: string
}

export default function BlogImage({
  src,
  alt,
  width = 800,
  height = 600,
  caption,
  className = ''
}: BlogImageProps) {
  return (
    <figure className={`my-8 ${className}`}>
      <div className="overflow-hidden rounded-md shadow-sm">
        <Image
          src={src}
          alt={alt}
          width={width}
          height={height}
          className="w-full h-auto object-cover"
          sizes="(max-width: 768px) 100vw, 800px"
          quality={85}
        />
      </div>
      {caption && (
        <figcaption className="mt-2 text-center text-sm text-gray-600 italic">
          {caption}
        </figcaption>
      )}
    </figure>
  )
}
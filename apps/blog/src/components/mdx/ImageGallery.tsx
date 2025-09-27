import Image from 'next/image'

interface GalleryImage {
  src: string
  alt: string
  caption?: string
}

interface ImageGalleryProps {
  images: GalleryImage[]
  columns?: 2 | 3 | 4
  className?: string
}

export default function ImageGallery({
  images,
  columns = 2,
  className = ''
}: ImageGalleryProps) {
  const gridClass = {
    2: 'grid-cols-1 md:grid-cols-2',
    3: 'grid-cols-1 md:grid-cols-2 lg:grid-cols-3',
    4: 'grid-cols-1 md:grid-cols-2 lg:grid-cols-4'
  }[columns]

  return (
    <div className={`my-8 ${className}`}>
      <div className={`grid gap-4 ${gridClass}`}>
        {images.map((image, index) => (
          <figure key={index} className="group">
            <div className="overflow-hidden rounded-md shadow-sm">
              <Image
                src={image.src}
                alt={image.alt}
                width={400}
                height={300}
                className="w-full h-48 object-cover transition-transform duration-200 group-hover:scale-105"
                sizes="(max-width: 768px) 100vw, (max-width: 1200px) 50vw, 25vw"
                quality={80}
              />
            </div>
            {image.caption && (
              <figcaption className="mt-2 text-center text-sm text-gray-600 italic">
                {image.caption}
              </figcaption>
            )}
          </figure>
        ))}
      </div>
    </div>
  )
}
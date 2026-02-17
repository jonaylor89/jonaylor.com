# PNG-DB

A simple database that stores JSON data rows as compressed text within the zTXt chunks of PNG image files. Each JSON row is associated with a pixel coordinate and can be queried using a simple SQL-like syntax.


**Try it online**: [https://pngdb.jonaylor.com](https://pngdb.jonaylor.com)

![Demo Screenshot](images/screenshot.png)

## Quick Start

```bash
pnpm install  # Install dependencies
pnpm dev      # Start development server
pnpm build    # Build for production
```

## Features

- **PNG Storage**: Stores JSON data in PNG zTXt chunks while maintaining a valid image file
- **Schema Definition**: Define field types for your JSON data structure
- **Coordinate-based Storage**: Associate each JSON row with pixel coordinates (x, y)
- **SQL-like Queries**: Query data using WHERE clauses with coordinate and JSON field filtering
- **Compression**: Uses zlib compression for efficient storage of JSON data
- **CLI Interface**: Easy-to-use command-line interface for database operations

## Installation

This web application uses the `@jonaylor89/png-db` npm package, which provides WebAssembly bindings for the PNG database.

```bash
pnpm install              # Install dependencies
pnpm dev                  # Start development server at http://localhost:3000
pnpm build                # Build for production
pnpm preview              # Preview production build
```

The application is built with [Vite](https://vitejs.dev/) and runs entirely in the browser using WebAssembly.

## Usage

### Web Interface

The web application provides an interactive interface to:

1. **Create a New Database**: Define dimensions (width × height) and schema in JSON format
2. **Load Existing Database**: Upload a PNG database file from your computer
3. **Insert Data**: Add JSON records at specific pixel coordinates
4. **Query Data**: Use SQL-like WHERE clauses to filter records
5. **Download Database**: Save your database as a PNG file

### Creating a Database

Use the web interface to create a database by specifying:
- **Width & Height**: Image dimensions (e.g., 256×256)
- **Schema**: JSON object defining field types, e.g., `{"name":"string","age":"number"}`

Alternatively, click "Create Sample Database" to get started quickly with pre-populated data.

### Inserting Data

Enter coordinates (x, y) and JSON data matching your schema:
```json
{"name": "Alice", "age": 30}
```

### Querying Data

Use WHERE clauses to filter records:
- `WHERE age > 28`
- `WHERE name = "Alice"`
- `WHERE x > 10 AND age >= 30`

## Query Syntax

The query engine supports simple WHERE clauses with the following features:

### Supported Operators
- `=` - Equal
- `!=` - Not equal  
- `>` - Greater than
- `<` - Less than
- `>=` - Greater than or equal
- `<=` - Less than or equal

### Supported Fields
- `x`, `y` - Pixel coordinates (numbers)
- Any field defined in your JSON schema

### Value Types
- **Strings**: Use double quotes, e.g., `name = "Alice"`
- **Numbers**: Integer or float, e.g., `age = 30` or `height = 5.9`
- **Booleans**: `true` or `false`

### Combining Conditions
Use `AND` to combine multiple conditions:
```
WHERE x > 100 AND y < 200 AND active = true AND age >= 25
```

## Development

This project uses:
- **Vite**: Fast build tool with excellent WebAssembly support
- **@jonaylor89/png-db**: npm package providing WebAssembly bindings
- **pnpm**: Fast, disk-efficient package manager

### Project Structure

```
pngdb/
├── index.html           # Main HTML file
├── public/
│   ├── app.js          # Application logic
│   └── style.css       # Styles
├── vite.config.js      # Vite configuration
└── package.json        # Dependencies and scripts
```

### Building for Production

```bash
pnpm build              # Creates dist/ directory
pnpm preview            # Preview production build locally
```

The production build includes:
- Optimized JavaScript bundles
- WASM file with proper loading
- Compressed assets

## Technical Details

### Storage Format

- **PNG Image**: Creates a valid PNG image (black pixels by default)
- **Schema**: Stored in a zTXt chunk with keyword "schema"
- **Data Rows**: Each row stored in a zTXt chunk with keyword "row_x_y" (where x,y are coordinates)
- **Compression**: All text data is compressed using zlib before storage

### File Structure

```
PNG File
├── IHDR chunk (image header)
├── zTXt chunk (keyword: "schema") - Database schema
├── zTXt chunk (keyword: "row_10_20") - JSON data at (10,20)
├── zTXt chunk (keyword: "row_50_100") - JSON data at (50,100)
├── ...
├── IDAT chunks (image data - black pixels)
└── IEND chunk (end marker)
```

## Limitations

- **Query Complexity**: Only supports simple WHERE clauses with AND conditions
- **Data Types**: Limited to JSON-compatible types (string, number, boolean, null)
- **Performance**: Not optimized for large datasets - intended for small to medium data storage
- **Concurrency**: No built-in support for concurrent access
- **Indexing**: No indexing - queries perform linear scans

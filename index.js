const express = require('express')
const multer = require('multer')
const jsQR = require('jsqr')
const sharp = require('sharp')
const path = require('path')
const fs = require('fs')
const QRCode = require('qrcode')
const cors = require('cors')

const app = express()
const port = 3000
const uploadDir = 'uploads'

app.use(cors({
    origin: 'http://localhost:3000',
    methods: ['GET', 'POST'],
    allowedHeaders: ['Content-Type', 'Authorization']
}))

app.use(express.static(path.join(__dirname, 'public')))
app.use('/uploads', express.static(uploadDir))
app.use(express.json())

if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true })
}

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => {
        const uniqueSuffix = `${Date.now()}-${Math.round(Math.random() * 1E9)}`
        cb(null, `qr-${uniqueSuffix}${path.extname(file.originalname)}`)
    }
})

const fileFilter = (req, file, cb) => {
    const allowedTypes = /jpeg|jpg|png|gif|webp/i
    const isValidType = allowedTypes.test(path.extname(file.originalname))
    const isValidMime = allowedTypes.test(file.mimetype)

    if (isValidType && isValidMime) {
        cb(null, true)
    } else {
        cb(new Error('Only image files (JPEG, PNG, GIF, WebP) are allowed!'), false)
    }
}

const upload = multer({
    storage,
    fileFilter,
    limits: {
        fileSize: 5 * 1024 * 1024, // 5MB
        files: 1
    }
})

const crc16 = str => {
    const polynomial = 0x1021
    let crc = 0xFFFF
    
    for (let i = 0; i < str.length; i++) {
        let byte = str.charCodeAt(i)
        crc ^= (byte << 8)
        
        for (let j = 0; j < 8; j++) {
            crc = ((crc & 0x8000) !== 0) 
                ? ((crc << 1) ^ polynomial) & 0xFFFF 
                : (crc << 1) & 0xFFFF
        }
    }
    return crc
}

const parseQRIS = qrisString => {
    const result = {}
    let position = 0

    while (position < qrisString.length) {
        const id = qrisString.substr(position, 2)
        const length = parseInt(qrisString.substr(position + 2, 2))
        
        if (isNaN(length) || position + 4 + length > qrisString.length) {
            throw new Error('Invalid QRIS format')
        }
        
        const value = qrisString.substr(position + 4, length)
        position += 4 + length
        result[id] = value

        if (['26', '27', '28', '29', '30', '31', '51'].includes(id)) {
            const subTags = {}
            let subPos = 0
            
            while (subPos < value.length) {
                const subId = value.substr(subPos, 2)
                const subLength = parseInt(value.substr(subPos + 2, 2))
                const subValue = value.substr(subPos + 4, subLength)
                subPos += 4 + subLength
                subTags[subId] = subValue
            }
            
            result[`${id}_data`] = subTags
        }
    }

    return result
}

const updateQRISAmount = (qrisString, newAmount) => {
    const baseString = qrisString.replace(/6304[0-9A-F]{4}$/, '')
    const amountRegex = /5404\d+/
    const amountStr = newAmount.toString()
    const newAmountField = '54' + amountStr.length.toString().padStart(2, '0') + amountStr
    
    const updatedString = amountRegex.test(baseString)
        ? baseString.replace(amountRegex, newAmountField)
        : baseString + newAmountField
    
    const crc = crc16(updatedString + '6304')
    const crcHex = crc.toString(16).toUpperCase().padStart(4, '0')
    
    return updatedString + '6304' + crcHex
}

const readQRCode = async imagePath => {
    try {
        const image = await sharp(imagePath)
            .ensureAlpha()
            .raw()
            .toBuffer({ resolveWithObject: true })

        const code = jsQR(
            new Uint8ClampedArray(image.data),
            image.info.width,
            image.info.height
        )

        if (!code) throw new Error('No QR code found in image')
        return code.data
    } catch (error) {
        throw new Error(`Failed to read QR code: ${error.message}`)
    }
}

const cleanupUploadedFile = async filePath => {
    try {
        if (filePath && fs.existsSync(filePath)) {
            await fs.promises.unlink(filePath)
        }
    } catch (error) {
        console.error('File cleanup error:', error)
    }
}

app.post('/upload-qr', upload.single('qr'), async (req, res) => {
    if (!req.file) {
        return res.status(400).json({
            success: false,
            error: 'No file uploaded'
        })
    }

    try {
        const qrString = await readQRCode(req.file.path)
        const parsedData = parseQRIS(qrString)
        
        await cleanupUploadedFile(req.file.path)
        
        res.json({
            success: true,
            data: {
                qrString,
                parsedData,
                timestamp: new Date().toISOString()
            }
        })
    } catch (error) {
        await cleanupUploadedFile(req.file?.path)
        
        res.status(500).json({
            success: false,
            error: error.message,
            timestamp: new Date().toISOString()
        })
    }
})

app.post('/generate-qr', async (req, res) => {
    const { qrString, amount } = req.body
    
    if (!qrString || !amount) {
        return res.status(400).json({
            success: false,
            error: 'QR string and amount are required',
            timestamp: new Date().toISOString()
        })
    }

    try {
        const updatedQrisString = updateQRISAmount(qrString, amount)
        const qrCodeDataUrl = await QRCode.toDataURL(updatedQrisString, {
            errorCorrectionLevel: 'H',
            margin: 2,
            scale: 10,
            color: {
                dark: '#000000',
                light: '#ffffff'
            }
        })

        res.json({
            success: true,
            data: {
                qrString: updatedQrisString,
                qrCodeImage: qrCodeDataUrl,
                timestamp: new Date().toISOString()
            }
        })
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message,
            timestamp: new Date().toISOString()
        })
    }
})

app.use((err, req, res, next) => {
    console.error('Global error:', err)
    
    const statusCode = err.status || 500
    const errorMessage = process.env.NODE_ENV === 'production' 
        ? 'Internal server error'
        : err.message

    res.status(statusCode).json({
        success: false,
        error: errorMessage,
        timestamp: new Date().toISOString()
    })
})

const startServer = async () => {
    try {
        await app.listen(port)
        console.log(`Server running on http://localhost:${port}`)
        console.log(`Upload directory: ${path.resolve(uploadDir)}`)
    } catch (error) {
        console.error('Failed to start server:', error)
        process.exit(1)
    }
}

startServer()
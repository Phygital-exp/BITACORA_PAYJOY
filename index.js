const express = require("express");
const cors = require("cors");
const multer = require("multer");
const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");

const app = express();

const PORT = process.env.PORT || 3000;
const {
    API_TOKEN,
    ALLOWED_ORIGINS,          // ej: "https://phygital-exp.github.io,http://localhost:5500"
    SUPERVISORES_REPORT = "supervisores_payjoy",
    AWS_REGION = "us-east-1",
    AWS_ACCESS_KEY_ID,
    AWS_SECRET_ACCESS_KEY,
    S3_BUCKET,
    S3_PREFIX = "bitacora_payjoy",
} = process.env;

const BASE_URL = "https://botai.smartdataautomation.com/api_backend_ai/dinamic-db/report/119";

const REPORTS = {
    supervisores: SUPERVISORES_REPORT,
    preguntas: "preguntas_vitacora_payjoy",
    respuestas: "respuestas_bitacora_payjoy",
    pdvs: "PayJoyPDVs",
    promotores: "PayJoyUsers",
};

if (!API_TOKEN) {
    console.error("❌ Falta la variable de entorno API_TOKEN");
    process.exit(1);
}

const AUTH_HEADERS = {
    Authorization: `Token ${API_TOKEN}`,
    "Content-Type": "application/json",
};

// ---------- Middlewares ----------
const origins = (ALLOWED_ORIGINS || "").split(",").map((o) => o.trim()).filter(Boolean);
app.use(cors(origins.length ? { origin: origins } : undefined));
app.use(express.json({ limit: "1mb" }));

const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
    fileFilter: (req, file, cb) => {
        if (/^image\/(jpe?g|png|webp|heic|heif)$/i.test(file.mimetype)) return cb(null, true);
        cb(new Error("Solo se permiten imágenes (jpg, png, webp, heic)"));
    },
});

const s3 = S3_BUCKET && AWS_ACCESS_KEY_ID && AWS_SECRET_ACCESS_KEY
    ? new S3Client({
        region: AWS_REGION,
        credentials: { accessKeyId: AWS_ACCESS_KEY_ID, secretAccessKey: AWS_SECRET_ACCESS_KEY },
    })
    : null;

// ---------- Helpers ----------

// Solo se reenvían filtros con nombres simples (CEDULA, ESTADO, FECHA, ...)
function buildQuery(query) {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query || {})) {
        if (/^[A-Za-z0-9_]{1,64}$/.test(key) && typeof value === "string" && value.length <= 200) {
            params.append(key, value);
        }
    }
    const qs = params.toString();
    return qs ? `?${qs}` : "";
}

async function upstream(report, { method = "GET", query, body } = {}) {
    const url = `${BASE_URL}/${report}${buildQuery(query)}`;
    const response = await fetch(url, {
        method,
        headers: AUTH_HEADERS,
        body: body ? JSON.stringify(body) : undefined,
    });

    const text = await response.text();
    if (!response.ok) {
        const err = new Error(`Error ${response.status}: ${text.substring(0, 200)}`);
        err.status = response.status;
        throw err;
    }
    try {
        return text ? JSON.parse(text) : {};
    } catch {
        return { raw: text };
    }
}

// La API puede devolver un arreglo directo o envuelto ({ data: [...] }, { results: [...] }, ...)
function extractRows(data) {
    if (Array.isArray(data)) return data;
    if (data && typeof data === "object") {
        for (const value of Object.values(data)) {
            if (Array.isArray(value)) return value;
        }
    }
    return [];
}

function onlyDigits(value) {
    return String(value || "").replace(/\D/g, "");
}

function handleError(res, err, mensaje) {
    console.error(`❌ ${mensaje}:`, err.message);
    res.status(err.status && err.status < 600 ? err.status : 500).json({ error: mensaje, details: err.message });
}

// Rutas GET de solo lectura que reenvían los filtros recibidos
function readRoute(path, reportKey, mensaje) {
    app.get(path, async (req, res) => {
        try {
            res.json(await upstream(REPORTS[reportKey], { query: req.query }));
        } catch (err) {
            handleError(res, err, mensaje);
        }
    });
}

// ---------- Rutas ----------

app.get("/", (req, res) => res.json({ ok: true, servicio: "Proxy Bitácora PayJoy" }));

// 1. Buscar supervisor por cédula
app.get("/api/payjoy/supervisor/:cedula", async (req, res) => {
    const cedula = onlyDigits(req.params.cedula);
    if (!cedula) return res.status(400).json({ error: "Cédula inválida" });

    try {
        const data = await upstream(REPORTS.supervisores, { query: { CEDULA: cedula } });
        const rows = extractRows(data).filter((r) => onlyDigits(r.CEDULA) === cedula);
        if (!rows.length) return res.status(404).json({ error: "No se encontró un usuario con esa cédula" });
        res.json(rows[0]);
    } catch (err) {
        handleError(res, err, "Error al consultar el supervisor");
    }
});

// 2. Preguntas agrupadas por NUMERO (la base trae una fila por cada opción de respuesta)
//    Usa ?raw=1 para obtener la respuesta original sin agrupar.
function campoRespuesta(numero, tipo) {
    if (tipo === "FOTO") return `FOTO_PREGUNTA_${numero}`;
    if (tipo === "ABIERTA") return `PREGUNTA_ABIERTA_${numero}`;
    return `PREGUNTA_${numero}`;
}

function agruparPreguntas(rows) {
    const map = new Map();
    for (const row of rows) {
        const numero = Number(row.NUMERO);
        if (!Number.isFinite(numero)) continue;
        const tipo = String(row.TIPO || "").trim().toUpperCase();

        if (!map.has(numero)) {
            map.set(numero, {
                NUMERO: numero,
                PREGUNTA: String(row.PREGUNTA || "").trim(),
                TIPO: tipo,
                APLICA_PREGUNTA_PDV_ASISTIDO: String(row.APLICA_PREGUNTA_PDV_ASISTIDO || "").trim().toUpperCase(),
                CAMPO: campoRespuesta(numero, tipo),
                OPCIONES: [],
            });
        }
        // Solo las preguntas cerradas tienen opciones reales
        const respuesta = String(row.RESPUESTA ?? "").trim();
        const pregunta = map.get(numero);
        if (tipo === "CERRADA" && respuesta && !pregunta.OPCIONES.includes(respuesta)) {
            pregunta.OPCIONES.push(respuesta);
        }
    }
    return [...map.values()].sort((a, b) => a.NUMERO - b.NUMERO);
}

app.get("/api/payjoy/preguntas", async (req, res) => {
    try {
        const data = await upstream(REPORTS.preguntas);
        if (req.query.raw === "1") return res.json(data);
        res.json(agruparPreguntas(extractRows(data)));
    } catch (err) {
        handleError(res, err, "Error al obtener las preguntas");
    }
});

// 3. Catálogos
readRoute("/api/payjoy/pdvs", "pdvs", "Error al obtener los PDVs");
readRoute("/api/payjoy/promotores", "promotores", "Error al obtener los promotores");

// 3b. Bitácoras pendientes de una cédula (para retomar si se salió)
app.get("/api/payjoy/bitacora/pendiente/:cedula", async (req, res) => {
    const cedula = onlyDigits(req.params.cedula);
    if (!cedula) return res.status(400).json({ error: "Cédula inválida" });

    try {
        const query = { CEDULA: cedula, ESTADO: "Pendiente" };
        if (req.query.FECHA) query.FECHA = String(req.query.FECHA);

        const data = await upstream(REPORTS.respuestas, { query });
        // Se filtra también aquí por si la API ignora algún filtro
        const rows = extractRows(data).filter((r) =>
            onlyDigits(r.CEDULA) === cedula &&
            String(r.ESTADO || "").toLowerCase() === "pendiente" &&
            (!req.query.FECHA || String(r.FECHA || "").startsWith(String(req.query.FECHA)))
        );
        res.json(rows);
    } catch (err) {
        handleError(res, err, "Error al consultar bitácoras pendientes");
    }
});

// 4. Guardar respuestas de la bitácora (se llama en cada respuesta)
//    - Sin _id  -> crea el registro; Mongo genera el _id y se devuelve al front.
//    - Con _id  -> actualiza ese mismo registro.
//    Respuesta siempre: { _id, result }
const MONGO_ID = /^[a-f0-9]{24}$/i;

// Busca el _id en las formas comunes de respuesta ({_id}, {result:{_id}}, {result:[{_id}]}, {id}, ...)
function extractId(data) {
    if (!data || typeof data !== "object") return null;
    const candidates = [data, data.result, data.data, ...(Array.isArray(data.result) ? data.result : [])];
    for (const c of candidates) {
        if (!c || typeof c !== "object") continue;
        for (const key of ["_id", "id", "inserted_id", "insertedId"]) {
            const value = c[key] && typeof c[key] === "object" ? c[key].$oid : c[key];
            if (typeof value === "string" && MONGO_ID.test(value)) return value;
        }
    }
    return null;
}

app.post("/api/payjoy/bitacora", async (req, res) => {
    // created / modified los maneja el servidor
    const { created, modified, ...body } = req.body || {};
    const cedula = onlyDigits(body.CEDULA);
    if (!cedula) return res.status(400).json({ error: "El registro debe incluir CEDULA" });
    if (body._id !== undefined && !MONGO_ID.test(String(body._id))) {
        return res.status(400).json({ error: "_id inválido" });
    }

    try {
        const result = await upstream(REPORTS.respuestas, { method: "POST", body });
        let id = body._id || extractId(result);

        // Si la API no devolvió el _id en la creación, se busca el registro recién creado
        if (!id) {
            const rows = extractRows(await upstream(REPORTS.respuestas, {
                query: { CEDULA: cedula, ESTADO: String(body.ESTADO || "Pendiente") },
            }));
            const match = rows
                .filter((r) =>
                    onlyDigits(r.CEDULA) === cedula &&
                    (!body.HORA_INICIO || r.HORA_INICIO === body.HORA_INICIO) &&
                    (!body.FECHA || String(r.FECHA || "").startsWith(String(body.FECHA).substring(0, 10)))
                )
                .sort((a, b) => String(b.created || "").localeCompare(String(a.created || "")))[0];
            id = match ? match._id : null;
        }

        if (!id) console.warn("⚠️ Registro guardado pero no se pudo obtener el _id", result);
        res.json({ _id: id, result });
    } catch (err) {
        handleError(res, err, "Error al guardar la bitácora");
    }
});

// 5. [PENDIENTE] Subir foto y devolver la URL pública (reemplaza el link que generaba el bot).
//    Aún no está definido dónde se guardarán las fotos; sin variables de S3 responde 501.
app.post("/api/payjoy/foto", (req, res) => {
    if (!s3) return res.status(501).json({ error: "Subida de fotos no configurada (faltan variables de S3)" });

    upload.single("foto")(req, res, async (uploadErr) => {
        if (uploadErr) return res.status(400).json({ error: uploadErr.message });
        if (!req.file) return res.status(400).json({ error: "No se recibió ninguna foto (campo 'foto')" });

        const cedula = onlyDigits(req.body.cedula) || "sin_cedula";
        const ext = (req.file.mimetype.split("/")[1] || "jpg").replace("jpeg", "jpg");
        const key = `${S3_PREFIX}/${cedula}_${Date.now()}_${Math.floor(Math.random() * 1e6)}.${ext}`;

        try {
            await s3.send(new PutObjectCommand({
                Bucket: S3_BUCKET,
                Key: key,
                Body: req.file.buffer,
                ContentType: req.file.mimetype,
            }));
            res.json({ url: `https://s3.amazonaws.com/${S3_BUCKET}/${key}` });
        } catch (err) {
            handleError(res, err, "Error al subir la foto");
        }
    });
});

app.listen(PORT, () => {
    console.log(`Servidor proxy escuchando en http://localhost:${PORT}`);
});

require("dotenv").config();

const express = require("express");
const path = require("path");
const crypto = require("crypto");
const multer = require("multer");

const app = express();

const PORT = process.env.PORT || 3030;

const SHOP = process.env.SHOPIFY_SHOP;
const CLIENT_ID = process.env.SHOPIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET;
const UPLOAD_API_KEY = process.env.UPLOAD_API_KEY;

// Command Elite HQ
const LOCATION_ID = "gid://shopify/Location/15027437646";

const API_VERSION = "2026-07";

// ---------------------------------------------------------
// BASIC VALIDATION
// ---------------------------------------------------------

if (!SHOP) {
  console.error("Missing SHOPIFY_SHOP");
}

if (!CLIENT_ID) {
  console.error("Missing SHOPIFY_CLIENT_ID");
}

if (!CLIENT_SECRET) {
  console.error("Missing SHOPIFY_CLIENT_SECRET");
}

if (!UPLOAD_API_KEY) {
  console.error("Missing UPLOAD_API_KEY");
}

// ---------------------------------------------------------
// EXPRESS SETUP
// ---------------------------------------------------------

app.use(
  express.json({
    limit: "35mb",
  })
);

app.use(
  express.urlencoded({
    extended: true,
    limit: "35mb",
  })
);

app.use(express.static(__dirname));

// ---------------------------------------------------------
// LOCAL IMAGE UPLOAD
// ---------------------------------------------------------

const upload = multer({
  storage: multer.memoryStorage(),

  limits: {
    fileSize: 20 * 1024 * 1024,
    files: 10,
  },

  fileFilter: (req, file, cb) => {
    const allowed = [
      "image/jpeg",
      "image/png",
      "image/webp",
    ];

    if (!allowed.includes(file.mimetype)) {
      return cb(
        new Error(
          "Only JPG, PNG and WEBP images are supported."
        )
      );
    }

    cb(null, true);
  },
});

// ---------------------------------------------------------
// HOME PAGE
// ---------------------------------------------------------

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// ---------------------------------------------------------
// HEALTH CHECK
// ---------------------------------------------------------

app.get("/healthz", (req, res) => {
  res.json({
    ok: true,
    service: "Command Elite Shopify Uploader",
  });
});

// ---------------------------------------------------------
// API KEY SECURITY
// ---------------------------------------------------------

function requireApiKey(req, res, next) {
  const authHeader = req.headers.authorization || "";

  if (!authHeader.startsWith("Bearer ")) {
    return res.status(401).json({
      success: false,
      error: "Missing Authorization Bearer token.",
    });
  }

  const suppliedKey = authHeader.substring(7).trim();

  if (!suppliedKey || suppliedKey !== UPLOAD_API_KEY) {
    return res.status(401).json({
      success: false,
      error: "Invalid API key.",
    });
  }

  next();
}

// ---------------------------------------------------------
// SHOPIFY ACCESS TOKEN
// ---------------------------------------------------------

async function getShopifyAccessToken() {
  const url =
    `https://${SHOP}/admin/oauth/access_token`;

  const response = await fetch(url, {
    method: "POST",

    headers: {
      "Content-Type": "application/json",
    },

    body: JSON.stringify({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      grant_type: "client_credentials",
    }),
  });

  const text = await response.text();

  let data;

  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(
      `Shopify authentication returned invalid JSON: ${text}`
    );
  }

  if (!response.ok) {
    throw new Error(
      `Shopify authentication failed: ${JSON.stringify(data)}`
    );
  }

  if (!data.access_token) {
    throw new Error(
      "Shopify authentication succeeded but no access token was returned."
    );
  }

  return data.access_token;
}

// ---------------------------------------------------------
// SHOPIFY GRAPHQL
// ---------------------------------------------------------

async function shopifyGraphQL(
  token,
  query,
  variables = {}
) {
  const response = await fetch(
    `https://${SHOP}/admin/api/${API_VERSION}/graphql.json`,
    {
      method: "POST",

      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": token,
      },

      body: JSON.stringify({
        query,
        variables,
      }),
    }
  );

  const text = await response.text();

  let json;

  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(
      `Shopify returned invalid JSON: ${text}`
    );
  }

  if (!response.ok) {
    throw new Error(
      `Shopify HTTP error ${response.status}: ${JSON.stringify(json)}`
    );
  }

  if (json.errors && json.errors.length) {
    throw new Error(
      `Shopify GraphQL error: ${JSON.stringify(json.errors)}`
    );
  }

  return json.data;
}

// ---------------------------------------------------------
// HELPERS
// ---------------------------------------------------------

function cleanString(value) {
  if (
    value === undefined ||
    value === null
  ) {
    return "";
  }

  return String(value).trim();
}

function cleanMoney(value) {
  const cleaned = cleanString(value);

  if (!cleaned) {
    return null;
  }

  const number = Number(
    cleaned.replace(/[^0-9.-]/g, "")
  );

  if (!Number.isFinite(number)) {
    return null;
  }

  return number.toFixed(2);
}

function cleanQuantity(value) {
  const number = parseInt(value, 10);

  if (!Number.isFinite(number)) {
    return 0;
  }

  return Math.max(0, number);
}

function normalizeStatus(value) {
  const status = cleanString(value).toUpperCase();

  if (status === "ACTIVE") {
    return "ACTIVE";
  }

  return "DRAFT";
}

function cleanTags(tags) {
  if (!tags) {
    return [];
  }

  if (Array.isArray(tags)) {
    return tags
      .map((tag) => cleanString(tag))
      .filter(Boolean);
  }

  return String(tags)
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean);
}

function safeFilename(name, mimeType = "") {
  let filename =
    cleanString(name) ||
    `product-image-${Date.now()}`;

  filename = filename.replace(
    /[^a-zA-Z0-9._-]/g,
    "-"
  );

  if (!filename.includes(".")) {
    if (mimeType === "image/png") {
      filename += ".png";
    } else if (mimeType === "image/webp") {
      filename += ".webp";
    } else {
      filename += ".jpg";
    }
  }

  return filename;
}

function isValidPublicUrl(value) {
  try {
    const url = new URL(value);

    return (
      url.protocol === "https:" ||
      url.protocol === "http:"
    );
  } catch {
    return false;
  }
}

function allowedMimeType(mimeType) {
  return [
    "image/jpeg",
    "image/png",
    "image/webp",
  ].includes(mimeType);
}

// ---------------------------------------------------------
// DUPLICATE CHECK
// ---------------------------------------------------------

async function searchProducts(
  token,
  searchQuery
) {
  const query = `
    query SearchProducts($query: String!) {
      products(
        first: 20
        query: $query
      ) {
        nodes {
          id
          title
          status
          handle

          variants(first: 20) {
            nodes {
              id
              barcode

              inventoryItem {
                id
                sku
              }
            }
          }
        }
      }
    }
  `;

  const data = await shopifyGraphQL(
    token,
    query,
    {
      query: searchQuery,
    }
  );

  return data.products.nodes || [];
}

async function checkDuplicates(
  token,
  product
) {
  const duplicates = [];

  const title = cleanString(product.title);
  const sku = cleanString(product.sku);
  const barcode = cleanString(product.barcode);

  // SKU
  if (sku) {
    const products = await searchProducts(
      token,
      `sku:"${sku.replace(/"/g, '\\"')}"`
    );

    for (const item of products) {
      for (const variant of item.variants.nodes) {
        const existingSku =
          variant.inventoryItem?.sku || "";

        if (
          existingSku.toLowerCase() ===
          sku.toLowerCase()
        ) {
          duplicates.push({
            type: "SKU",
            value: sku,
            productTitle: item.title,
            productStatus: item.status,
            productId: item.id,
          });
        }
      }
    }
  }

  // BARCODE
  if (barcode) {
    const products = await searchProducts(
      token,
      `barcode:"${barcode.replace(/"/g, '\\"')}"`
    );

    for (const item of products) {
      for (const variant of item.variants.nodes) {
        const existingBarcode =
          variant.barcode || "";

        if (
          existingBarcode.toLowerCase() ===
          barcode.toLowerCase()
        ) {
          duplicates.push({
            type: "BARCODE",
            value: barcode,
            productTitle: item.title,
            productStatus: item.status,
            productId: item.id,
          });
        }
      }
    }
  }

  // EXACT TITLE
  if (title) {
    const products = await searchProducts(
      token,
      `title:"${title.replace(/"/g, '\\"')}"`
    );

    for (const item of products) {
      if (
        item.title.trim().toLowerCase() ===
        title.toLowerCase()
      ) {
        duplicates.push({
          type: "TITLE",
          value: title,
          productTitle: item.title,
          productStatus: item.status,
          productId: item.id,
        });
      }
    }
  }

  // Remove repeated results
  const unique = [];

  const seen = new Set();

  for (const duplicate of duplicates) {
    const key =
      `${duplicate.type}|${duplicate.value}|${duplicate.productId}`;

    if (!seen.has(key)) {
      seen.add(key);
      unique.push(duplicate);
    }
  }

  return unique;
}

// ---------------------------------------------------------
// SHOPIFY STAGED IMAGE UPLOAD
// ---------------------------------------------------------

async function stageImage(
  token,
  file
) {
  if (!file || !file.buffer) {
    throw new Error(
      "Image file buffer is missing."
    );
  }

  const mimeType =
    file.mimetype ||
    file.mimeType ||
    "image/jpeg";

  if (!allowedMimeType(mimeType)) {
    throw new Error(
      `Unsupported image type: ${mimeType}`
    );
  }

  if (
    file.buffer.length >
    20 * 1024 * 1024
  ) {
    throw new Error(
      "Image exceeds the 20 MB limit."
    );
  }

  const filename = safeFilename(
    file.originalname ||
      file.name,
    mimeType
  );

  const mutation = `
    mutation stagedUploadsCreate(
      $input: [StagedUploadInput!]!
    ) {
      stagedUploadsCreate(
        input: $input
      ) {
        stagedTargets {
          url
          resourceUrl

          parameters {
            name
            value
          }
        }

        userErrors {
          field
          message
        }
      }
    }
  `;

  const data = await shopifyGraphQL(
    token,
    mutation,
    {
      input: [
        {
          filename,
          mimeType,
          httpMethod: "POST",
          resource: "PRODUCT_IMAGE",
        },
      ],
    }
  );

  const result =
    data.stagedUploadsCreate;

  if (
    result.userErrors &&
    result.userErrors.length
  ) {
    throw new Error(
      `Shopify staged upload error: ${JSON.stringify(result.userErrors)}`
    );
  }

  const target =
    result.stagedTargets?.[0];

  if (!target) {
    throw new Error(
      "Shopify did not return a staged upload target."
    );
  }

  const formData = new FormData();

  for (
    const parameter of
    target.parameters || []
  ) {
    formData.append(
      parameter.name,
      parameter.value
    );
  }

  const blob = new Blob(
    [file.buffer],
    {
      type: mimeType,
    }
  );

  formData.append(
    "file",
    blob,
    filename
  );

  const uploadResponse = await fetch(
    target.url,
    {
      method: "POST",
      body: formData,
    }
  );

  if (!uploadResponse.ok) {
    const uploadText =
      await uploadResponse.text();

    throw new Error(
      `Shopify staged image upload failed: ${uploadResponse.status} ${uploadText}`
    );
  }

  return target.resourceUrl;
}

// ---------------------------------------------------------
// DOWNLOAD CHATGPT IMAGE
// ---------------------------------------------------------

async function downloadImageFromUrl(
  downloadUrl,
  preferredName,
  preferredMimeType
) {
  if (!isValidPublicUrl(downloadUrl)) {
    throw new Error(
      "ChatGPT image download URL is invalid."
    );
  }

  const response = await fetch(
    downloadUrl,
    {
      method: "GET",

      headers: {
        "User-Agent":
          "Command-Elite-Shopify-Uploader/1.0",
      },

      redirect: "follow",
    }
  );

  if (!response.ok) {
    throw new Error(
      `Unable to download ChatGPT image: HTTP ${response.status}`
    );
  }

  const arrayBuffer =
    await response.arrayBuffer();

  const buffer = Buffer.from(
    arrayBuffer
  );

  if (
    buffer.length >
    20 * 1024 * 1024
  ) {
    throw new Error(
      "Downloaded ChatGPT image exceeds 20 MB."
    );
  }

  let mimeType =
    cleanString(preferredMimeType);

  if (!mimeType) {
    const contentType =
      response.headers.get(
        "content-type"
      );

    mimeType = cleanString(
      contentType
    ).split(";")[0];
  }

  if (!allowedMimeType(mimeType)) {
    throw new Error(
      `Downloaded file is not a supported image type: ${mimeType || "unknown"}`
    );
  }

  return {
    originalname: safeFilename(
      preferredName,
      mimeType
    ),

    mimetype: mimeType,

    buffer,
  };
}

// ---------------------------------------------------------
// OPENAI FILE REFERENCE HANDLING
// ---------------------------------------------------------

async function resolveOpenAIFileRefs(
  token,
  refs
) {
  const stagedUrls = [];

  if (!Array.isArray(refs)) {
    return stagedUrls;
  }

  for (let i = 0; i < refs.length; i++) {
    const ref = refs[i];

    try {
      let downloadLink = "";
      let name =
        `chatgpt-image-${i + 1}.jpg`;
      let mimeType = "";

      // Object format
      if (
        ref &&
        typeof ref === "object"
      ) {
        downloadLink =
          cleanString(
            ref.download_link ||
            ref.downloadLink ||
            ref.url
          );

        name =
          cleanString(
            ref.name ||
            ref.filename
          ) || name;

        mimeType =
          cleanString(
            ref.mime_type ||
            ref.mimeType
          );
      }

      // String URL fallback
      if (
        typeof ref === "string"
      ) {
        if (isValidPublicUrl(ref)) {
          downloadLink = ref;
        }
      }

      if (!downloadLink) {
        console.warn(
          "Skipping OpenAI file reference because it has no download link:",
          ref
        );

        continue;
      }

      const file =
        await downloadImageFromUrl(
          downloadLink,
          name,
          mimeType
        );

      const stagedUrl =
        await stageImage(
          token,
          file
        );

      stagedUrls.push(stagedUrl);
    } catch (error) {
      console.error(
        "OpenAI image reference failed:",
        error.message
      );
    }
  }

  return stagedUrls;
}

// ---------------------------------------------------------
// BASE64 DATA URL FALLBACK
// ---------------------------------------------------------

async function resolveImageDataUrl(
  token,
  imageDataUrl,
  imageFilename
) {
  const dataUrl =
    cleanString(imageDataUrl);

  if (!dataUrl) {
    return null;
  }

  const match = dataUrl.match(
    /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=\r\n]+)$/
  );

  if (!match) {
    throw new Error(
      "imageDataUrl must be a valid JPG, PNG or WEBP base64 data URL."
    );
  }

  const mimeType = match[1];

  const base64Data =
    match[2].replace(/\s/g, "");

  const buffer = Buffer.from(
    base64Data,
    "base64"
  );

  if (!buffer.length) {
    throw new Error(
      "imageDataUrl decoded to an empty image."
    );
  }

  if (
    buffer.length >
    20 * 1024 * 1024
  ) {
    throw new Error(
      "Decoded image exceeds 20 MB."
    );
  }

  const extension =
    mimeType === "image/png"
      ? ".png"
      : mimeType === "image/webp"
      ? ".webp"
      : ".jpg";

  let filename =
    cleanString(imageFilename);

  if (!filename) {
    filename =
      `chatgpt-product-image-${Date.now()}${extension}`;
  }

  const file = {
    originalname: safeFilename(
      filename,
      mimeType
    ),

    mimetype: mimeType,

    buffer,
  };

  return stageImage(
    token,
    file
  );
}

// ---------------------------------------------------------
// RESOLVE ALL IMAGE SOURCES
// ---------------------------------------------------------

async function resolveImageSources(
  token,
  product,
  localFiles = []
) {
  const imageSources = [];
  const imageNotes = [];

  // -------------------------------------------------------
  // 1. NORMAL PUBLIC IMAGE URLS
  // -------------------------------------------------------

  if (
    Array.isArray(product.imageUrls)
  ) {
    for (
      const rawUrl of
      product.imageUrls
    ) {
      const url =
        cleanString(rawUrl);

      if (
        url &&
        isValidPublicUrl(url)
      ) {
        imageSources.push(url);
      }
    }
  }

  // -------------------------------------------------------
  // 2. CHATGPT / OPENAI FILE REFERENCES
  // -------------------------------------------------------

  if (
    imageSources.length === 0 &&
    Array.isArray(
      product.openaiFileIdRefs
    ) &&
    product.openaiFileIdRefs.length
  ) {
    const staged =
      await resolveOpenAIFileRefs(
        token,
        product.openaiFileIdRefs
      );

    imageSources.push(...staged);

    if (staged.length) {
      imageNotes.push(
        `${staged.length} ChatGPT image(s) staged to Shopify.`
      );
    }
  }

  // -------------------------------------------------------
  // 3. BASE64 FALLBACK
  // -------------------------------------------------------

  if (
    imageSources.length === 0 &&
    product.imageDataUrl
  ) {
    try {
      const stagedUrl =
        await resolveImageDataUrl(
          token,
          product.imageDataUrl,
          product.imageFilename
        );

      if (stagedUrl) {
        imageSources.push(
          stagedUrl
        );

        imageNotes.push(
          "Fallback base64 image staged to Shopify."
        );
      }
    } catch (error) {
      console.error(
        "Base64 image fallback failed:",
        error.message
      );

      imageNotes.push(
        `Base64 image failed: ${error.message}`
      );
    }
  }

  // -------------------------------------------------------
  // 4. LOCAL BROWSER FILES
  // -------------------------------------------------------

  if (
    imageSources.length === 0 &&
    Array.isArray(localFiles) &&
    localFiles.length
  ) {
    for (const file of localFiles) {
      try {
        const stagedUrl =
          await stageImage(
            token,
            file
          );

        imageSources.push(
          stagedUrl
        );
      } catch (error) {
        console.error(
          "Local image staging failed:",
          error.message
        );
      }
    }

    if (imageSources.length) {
      imageNotes.push(
        `${imageSources.length} local image(s) staged to Shopify.`
      );
    }
  }

  if (
    imageSources.length === 0
  ) {
    imageNotes.push(
      "No usable image was supplied. Product will be created without an image."
    );
  }

  return {
    imageSources,
    imageNotes,
  };
}

// ---------------------------------------------------------
// CREATE SHOPIFY PRODUCT
// ---------------------------------------------------------

async function createProduct(
  token,
  product,
  imageSources
) {
  const media = imageSources.map(
    (source) => ({
      mediaContentType: "IMAGE",
      originalSource: source,
      alt:
        cleanString(product.title) ||
        "Product image",
    })
  );

  const mutation = `
    mutation CreateProduct(
      $product: ProductCreateInput!
      $media: [CreateMediaInput!]
    ) {
      productCreate(
        product: $product
        media: $media
      ) {
        product {
          id
          title
          handle
          status

          variants(first: 1) {
            nodes {
              id
              barcode
              price

              inventoryItem {
                id
                sku
                tracked
              }
            }
          }

          media(first: 20) {
            nodes {
              id
              mediaContentType
            }
          }
        }

        userErrors {
          field
          message
        }
      }
    }
  `;

  const productInput = {
    title: cleanString(
      product.title
    ),

    status: normalizeStatus(
      product.status
    ),
  };

  if (
    cleanString(
      product.descriptionHtml
    )
  ) {
    productInput.descriptionHtml =
      cleanString(
        product.descriptionHtml
      );
  }

  if (
    cleanString(product.vendor)
  ) {
    productInput.vendor =
      cleanString(product.vendor);
  }

  if (
    cleanString(
      product.productType
    )
  ) {
    productInput.productType =
      cleanString(
        product.productType
      );
  }

  const tags =
    cleanTags(product.tags);

  if (tags.length) {
    productInput.tags = tags;
  }

  const data = await shopifyGraphQL(
    token,
    mutation,
    {
      product: productInput,
      media,
    }
  );

  const result =
    data.productCreate;

  if (
    result.userErrors &&
    result.userErrors.length
  ) {
    throw new Error(
      `Product creation failed: ${JSON.stringify(result.userErrors)}`
    );
  }

  if (!result.product) {
    throw new Error(
      "Shopify did not return the new product."
    );
  }

  return result.product;
}

// ---------------------------------------------------------
// UPDATE DEFAULT VARIANT
// ---------------------------------------------------------

async function updateVariant(
  token,
  productId,
  variantId,
  product
) {
  const price =
    cleanMoney(product.price);

  const cost =
    cleanMoney(product.cost);

  const sku =
    cleanString(product.sku);

  const barcode =
    cleanString(product.barcode);

  const variantInput = {
    id: variantId,

    inventoryItem: {
      tracked: true,
    },
  };

  if (price !== null) {
    variantInput.price = price;
  }

  if (barcode) {
    variantInput.barcode =
      barcode;
  }

  if (sku) {
    variantInput.inventoryItem.sku =
      sku;
  }

  if (cost !== null) {
    variantInput.inventoryItem.cost =
      cost;
  }

  const mutation = `
    mutation UpdateVariant(
      $productId: ID!
      $variants: [ProductVariantsBulkInput!]!
    ) {
      productVariantsBulkUpdate(
        productId: $productId
        variants: $variants
      ) {
        productVariants {
          id
          price
          barcode

          inventoryItem {
            id
            sku
            tracked
          }
        }

        userErrors {
          field
          message
        }
      }
    }
  `;

  const data = await shopifyGraphQL(
    token,
    mutation,
    {
      productId,
      variants: [
        variantInput,
      ],
    }
  );

  const result =
    data.productVariantsBulkUpdate;

  if (
    result.userErrors &&
    result.userErrors.length
  ) {
    throw new Error(
      `Variant update failed: ${JSON.stringify(result.userErrors)}`
    );
  }

  const variant =
    result.productVariants?.[0];

  if (!variant) {
    throw new Error(
      "Shopify did not return the updated variant."
    );
  }

  return variant;
}

// ---------------------------------------------------------
// ACTIVATE INVENTORY AT HQ
// ---------------------------------------------------------

async function activateInventory(
  token,
  inventoryItemId,
  quantity
) {
  const idempotencyKey =
    crypto.randomUUID();

  const mutation = `
    mutation ActivateInventory(
      $inventoryItemId: ID!
      $locationId: ID!
      $available: Int
      $idempotencyKey: String!
    ) {
      inventoryActivate(
        inventoryItemId: $inventoryItemId
        locationId: $locationId
        available: $available
      )
      @idempotent(
        key: $idempotencyKey
      ) {
        inventoryLevel {
          id

          quantities(
            names: ["available"]
          ) {
            name
            quantity
          }
        }

        userErrors {
          field
          message
        }
      }
    }
  `;

  try {
    const data =
      await shopifyGraphQL(
        token,
        mutation,
        {
          inventoryItemId,
          locationId:
            LOCATION_ID,
          available: quantity,
          idempotencyKey,
        }
      );

    const result =
      data.inventoryActivate;

    if (
      result?.userErrors &&
      result.userErrors.length === 0
    ) {
      return true;
    }

    if (
      result?.inventoryLevel
    ) {
      return true;
    }

    console.warn(
      "Inventory activate returned errors. Falling back to quantity set:",
      result?.userErrors
    );
  } catch (error) {
    console.warn(
      "Inventory activate failed. Falling back to quantity set:",
      error.message
    );
  }

  return false;
}

// ---------------------------------------------------------
// SET INVENTORY QUANTITY
// ---------------------------------------------------------

async function setInventoryQuantity(
  token,
  inventoryItemId,
  quantity
) {
  const mutation = `
    mutation SetInventoryQuantity(
      $input: InventorySetQuantitiesInput!
    ) {
      inventorySetQuantities(
        input: $input
      ) {
        inventoryAdjustmentGroup {
          reason

          changes {
            name
            delta
            quantityAfterChange
          }
        }

        userErrors {
          code
          field
          message
        }
      }
    }
  `;

  const input = {
    name: "available",
    reason: "correction",
    ignoreCompareQuantity: true,

    quantities: [
      {
        inventoryItemId,
        locationId:
          LOCATION_ID,
        quantity,
      },
    ],
  };

  const data = await shopifyGraphQL(
    token,
    mutation,
    {
      input,
    }
  );

  const result =
    data.inventorySetQuantities;

  if (
    result.userErrors &&
    result.userErrors.length
  ) {
    throw new Error(
      `Inventory quantity update failed: ${JSON.stringify(result.userErrors)}`
    );
  }

  return true;
}

// ---------------------------------------------------------
// MAIN PRODUCT PROCESSOR
// ---------------------------------------------------------

async function processProduct(
  product,
  localFiles = []
) {
  const title =
    cleanString(product.title);

  if (!title) {
    const error =
      new Error(
        "Product title is required."
      );

    error.statusCode = 400;

    throw error;
  }

  const quantity =
    cleanQuantity(
      product.quantity
    );

  const status =
    normalizeStatus(
      product.status
    );

  product.quantity = quantity;
  product.status = status;

  // Authenticate
  const token =
    await getShopifyAccessToken();

  // -------------------------------------------------------
  // DUPLICATE CHECK FIRST
  // -------------------------------------------------------

  const duplicates =
    await checkDuplicates(
      token,
      product
    );

  if (duplicates.length) {
    const error =
      new Error(
        "Duplicate Shopify product detected."
      );

    error.statusCode = 409;
    error.duplicates =
      duplicates;

    throw error;
  }

  // -------------------------------------------------------
  // RESOLVE IMAGES
  // -------------------------------------------------------

  const {
    imageSources,
    imageNotes,
  } = await resolveImageSources(
    token,
    product,
    localFiles
  );

  // -------------------------------------------------------
  // CREATE PRODUCT
  // -------------------------------------------------------

  const newProduct =
    await createProduct(
      token,
      product,
      imageSources
    );

  const firstVariant =
    newProduct.variants?.nodes?.[0];

  if (!firstVariant) {
    throw new Error(
      "Shopify created the product but no default variant was returned."
    );
  }

  // -------------------------------------------------------
  // UPDATE VARIANT DETAILS
  // -------------------------------------------------------

  const updatedVariant =
    await updateVariant(
      token,
      newProduct.id,
      firstVariant.id,
      product
    );

  const inventoryItemId =
    updatedVariant.inventoryItem?.id;

  if (!inventoryItemId) {
    throw new Error(
      "Shopify did not return an inventory item ID."
    );
  }

  // -------------------------------------------------------
  // INVENTORY
  // -------------------------------------------------------

  const activated =
    await activateInventory(
      token,
      inventoryItemId,
      quantity
    );

  if (!activated) {
    await setInventoryQuantity(
      token,
      inventoryItemId,
      quantity
    );
  }

  return {
    success: true,

    title:
      newProduct.title,

    status:
      newProduct.status,

    productId:
      newProduct.id,

    handle:
      newProduct.handle,

    sku:
      updatedVariant.inventoryItem?.sku ||
      cleanString(product.sku),

    barcode:
      updatedVariant.barcode ||
      cleanString(
        product.barcode
      ),

    price:
      updatedVariant.price ||
      cleanMoney(
        product.price
      ) ||
      "",

    quantity,

    location:
      "Command Elite HQ",

    locationId:
      LOCATION_ID,

    images:
      imageSources.length,

    imageSources,

    imageNotes,
  };
}

// ---------------------------------------------------------
// CHATGPT / GPT ACTION ENDPOINT
// ---------------------------------------------------------

app.post(
  "/api/upload-product",
  requireApiKey,
  async (req, res) => {
    try {
      const product =
        req.body || {};

      const result =
        await processProduct(
          product
        );

      res.status(200).json(
        result
      );
    } catch (error) {
      console.error(
        "API upload error:",
        error
      );

      if (
        error.statusCode === 409
      ) {
        return res
          .status(409)
          .json({
            success: false,
            duplicate: true,
            error:
              error.message,
            duplicates:
              error.duplicates || [],
          });
      }

      res
        .status(
          error.statusCode || 500
        )
        .json({
          success: false,
          error:
            error.message ||
            "Unknown server error.",
        });
    }
  }
);

// ---------------------------------------------------------
// OLD BROWSER / MULTIPART UPLOADER
// ---------------------------------------------------------

app.post(
  "/upload",
  requireApiKey,
  upload.array(
    "images",
    10
  ),
  async (req, res) => {
    try {
      const product = {
        title:
          req.body.title,

        descriptionHtml:
          req.body.descriptionHtml ||
          req.body.description,

        vendor:
          req.body.vendor,

        productType:
          req.body.productType,

        sku:
          req.body.sku,

        barcode:
          req.body.barcode,

        price:
          req.body.price,

        cost:
          req.body.cost,

        quantity:
          req.body.quantity,

        status:
          req.body.status,

        tags:
          req.body.tags,

        imageUrls: [],
      };

      if (
        req.body.imageUrls
      ) {
        if (
          Array.isArray(
            req.body.imageUrls
          )
        ) {
          product.imageUrls =
            req.body.imageUrls;
        } else {
          product.imageUrls =
            String(
              req.body.imageUrls
            )
              .split(/\r?\n|,/)
              .map((x) =>
                x.trim()
              )
              .filter(Boolean);
        }
      }

      const result =
        await processProduct(
          product,
          req.files || []
        );

      res.status(200).json(
        result
      );
    } catch (error) {
      console.error(
        "Browser upload error:",
        error
      );

      if (
        error.statusCode === 409
      ) {
        return res
          .status(409)
          .json({
            success: false,
            duplicate: true,
            error:
              error.message,
            duplicates:
              error.duplicates || [],
          });
      }

      res
        .status(
          error.statusCode || 500
        )
        .json({
          success: false,
          error:
            error.message ||
            "Unknown server error.",
        });
    }
  }
);

// ---------------------------------------------------------
// MULTER ERROR HANDLER
// ---------------------------------------------------------

app.use(
  (error, req, res, next) => {
    if (
      error instanceof
      multer.MulterError
    ) {
      return res
        .status(400)
        .json({
          success: false,
          error:
            error.message,
        });
    }

    if (error) {
      return res
        .status(400)
        .json({
          success: false,
          error:
            error.message,
        });
    }

    next();
  }
);

// ---------------------------------------------------------
// START SERVER
// ---------------------------------------------------------

app.listen(
  PORT,
  "0.0.0.0",
  () => {
    console.log(
      `Command Elite Shopify Uploader running on port ${PORT}`
    );

    console.log(
      `Shop: ${SHOP}`
    );

    console.log(
      `Shopify API: ${API_VERSION}`
    );

    console.log(
      `Inventory location: Command Elite HQ`
    );
  }
);

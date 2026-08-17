require("dotenv").config({ quiet: true });

const express = require("express");
const crypto = require("crypto");
const path = require("path");
const multer = require("multer");

const app = express();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 20 * 1024 * 1024,
    files: 10
  }
});

// ======================================================
// SETTINGS
// ======================================================

const shop = process.env.SHOPIFY_SHOP;
const clientId = process.env.SHOPIFY_CLIENT_ID;
const clientSecret = process.env.SHOPIFY_CLIENT_SECRET;
const uploadApiKey = process.env.UPLOAD_API_KEY;

// Command Elite HQ
const LOCATION_ID = "gid://shopify/Location/15027437646";

// Works locally on 3030 and automatically uses Render's port online
const PORT = process.env.PORT || 3030;

app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

// ======================================================
// STARTUP CHECK
// ======================================================

function checkEnvironment() {
  const missing = [];

  if (!shop) missing.push("SHOPIFY_SHOP");
  if (!clientId) missing.push("SHOPIFY_CLIENT_ID");
  if (!clientSecret) missing.push("SHOPIFY_CLIENT_SECRET");
  if (!uploadApiKey) missing.push("UPLOAD_API_KEY");

  if (missing.length) {
    console.error(
      "Missing environment variables:",
      missing.join(", ")
    );
  }
}

checkEnvironment();

// ======================================================
// PRIVATE API SECURITY
// ======================================================

function requireApiKey(req, res, next) {
  const authHeader =
    req.headers.authorization || "";

  if (!authHeader.startsWith("Bearer ")) {
    return res.status(401).json({
      success: false,
      error: "Unauthorized"
    });
  }

  const suppliedKey =
    authHeader.substring(7).trim();

  if (
    !uploadApiKey ||
    suppliedKey !== uploadApiKey
  ) {
    return res.status(401).json({
      success: false,
      error: "Unauthorized"
    });
  }

  next();
}

// ======================================================
// SHOPIFY ACCESS TOKEN
// ======================================================

async function getToken() {
  const response = await fetch(
    `https://${shop}/admin/oauth/access_token`,
    {
      method: "POST",

      headers: {
        "Content-Type":
          "application/x-www-form-urlencoded",
        Accept: "application/json"
      },

      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: clientId,
        client_secret: clientSecret
      })
    }
  );

  const data = await response.json();

  if (!response.ok) {
    throw new Error(
      "Shopify authentication failed:\n" +
      JSON.stringify(data, null, 2)
    );
  }

  return data.access_token;
}

// ======================================================
// GRAPHQL HELPER
// ======================================================

async function graphql(
  token,
  query,
  variables = {}
) {
  const response = await fetch(
    `https://${shop}/admin/api/2026-07/graphql.json`,
    {
      method: "POST",

      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": token
      },

      body: JSON.stringify({
        query,
        variables
      })
    }
  );

  const result = await response.json();

  if (result.errors) {
    throw new Error(
      "Shopify GraphQL error:\n" +
      JSON.stringify(result.errors, null, 2)
    );
  }

  return result.data;
}

// ======================================================
// SHOPIFY SEARCH ESCAPING
// ======================================================

function escapeSearchValue(value) {
  return String(value || "")
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"');
}

// ======================================================
// DUPLICATE CHECK
// ======================================================

async function checkForDuplicates(
  token,
  product
) {
  const duplicates = [];

  // SKU
  if (
    product.sku &&
    String(product.sku).trim()
  ) {
    const query = `
      query FindSku($query: String!) {
        productVariants(
          first: 10,
          query: $query
        ) {
          nodes {
            id
            sku
            barcode

            product {
              id
              title
              status
            }
          }
        }
      }
    `;

    const sku =
      String(product.sku).trim();

    const data = await graphql(
      token,
      query,
      {
        query:
          `sku:"${escapeSearchValue(sku)}"`
      }
    );

    const matches =
      data.productVariants.nodes.filter(
        variant =>
          String(variant.sku || "")
            .trim()
            .toLowerCase() ===
          sku.toLowerCase()
      );

    for (const match of matches) {
      duplicates.push({
        type: "SKU",
        value: sku,
        productTitle:
          match.product.title,
        productStatus:
          match.product.status
      });
    }
  }

  // BARCODE
  if (
    product.barcode &&
    String(product.barcode).trim()
  ) {
    const query = `
      query FindBarcode($query: String!) {
        productVariants(
          first: 10,
          query: $query
        ) {
          nodes {
            id
            sku
            barcode

            product {
              id
              title
              status
            }
          }
        }
      }
    `;

    const barcode =
      String(product.barcode).trim();

    const data = await graphql(
      token,
      query,
      {
        query:
          `barcode:"${escapeSearchValue(
            barcode
          )}"`
      }
    );

    const matches =
      data.productVariants.nodes.filter(
        variant =>
          String(variant.barcode || "")
            .trim() ===
          barcode
      );

    for (const match of matches) {
      duplicates.push({
        type: "BARCODE",
        value: barcode,
        productTitle:
          match.product.title,
        productStatus:
          match.product.status
      });
    }
  }

  // EXACT TITLE
  if (
    product.title &&
    String(product.title).trim()
  ) {
    const query = `
      query FindTitle($query: String!) {
        products(
          first: 20,
          query: $query
        ) {
          nodes {
            id
            title
            status
          }
        }
      }
    `;

    const title =
      String(product.title).trim();

    const data = await graphql(
      token,
      query,
      {
        query:
          `title:"${escapeSearchValue(
            title
          )}"`
      }
    );

    const matches =
      data.products.nodes.filter(
        existing =>
          existing.title
            .trim()
            .toLowerCase() ===
          title.toLowerCase()
      );

    for (const match of matches) {
      duplicates.push({
        type: "TITLE",
        value: title,
        productTitle:
          match.title,
        productStatus:
          match.status
      });
    }
  }

  return duplicates;
}

// ======================================================
// STAGE LOCAL IMAGE TO SHOPIFY
// ======================================================

async function stageImage(
  token,
  file
) {
  const mutation = `
    mutation StagedUploadsCreate(
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

  const data = await graphql(
    token,
    mutation,
    {
      input: [
        {
          filename:
            file.originalname,

          mimeType:
            file.mimetype,

          httpMethod:
            "POST",

          resource:
            "PRODUCT_IMAGE"
        }
      ]
    }
  );

  const output =
    data.stagedUploadsCreate;

  if (output.userErrors.length) {
    throw new Error(
      "Staged image upload failed:\n" +
      JSON.stringify(
        output.userErrors,
        null,
        2
      )
    );
  }

  const target =
    output.stagedTargets[0];

  const form = new FormData();

  for (
    const parameter of target.parameters
  ) {
    form.append(
      parameter.name,
      parameter.value
    );
  }

  const blob = new Blob(
    [file.buffer],
    {
      type: file.mimetype
    }
  );

  form.append(
    "file",
    blob,
    file.originalname
  );

  const uploadResponse =
    await fetch(
      target.url,
      {
        method: "POST",
        body: form
      }
    );

  if (!uploadResponse.ok) {
    const text =
      await uploadResponse.text();

    throw new Error(
      `Image transfer failed (${uploadResponse.status}):\n${text}`
    );
  }

  return target.resourceUrl;
}

// ======================================================
// CREATE PRODUCT
// ======================================================

async function createProduct(
  token,
  product,
  imageSources
) {
  const mutation = `
    mutation CreateProduct(
      $product: ProductCreateInput!,
      $media: [CreateMediaInput!]
    ) {
      productCreate(
        product: $product,
        media: $media
      ) {
        product {
          id
          title
          status
          handle

          variants(first: 1) {
            nodes {
              id

              inventoryItem {
                id
              }
            }
          }

          media(first: 20) {
            nodes {
              id
              mediaContentType

              preview {
                status
              }
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

  const media =
    (imageSources || [])
      .filter(Boolean)
      .map(source => ({
        originalSource: source,
        mediaContentType: "IMAGE",
        alt: product.title
      }));

  const data = await graphql(
    token,
    mutation,
    {
      product: {
        title:
          product.title,

        descriptionHtml:
          product.descriptionHtml || "",

        vendor:
          product.vendor || "",

        productType:
          product.productType || "",

        tags:
          product.tags || [],

        status:
          product.status || "DRAFT"
      },

      media
    }
  );

  const output =
    data.productCreate;

  if (output.userErrors.length) {
    throw new Error(
      "Product creation failed:\n" +
      JSON.stringify(
        output.userErrors,
        null,
        2
      )
    );
  }

  return output.product;
}

// ======================================================
// UPDATE DEFAULT VARIANT
// ======================================================

async function updateVariant(
  token,
  productId,
  variantId,
  product
) {
  const mutation = `
    mutation UpdateVariant(
      $productId: ID!,
      $variants: [ProductVariantsBulkInput!]!
    ) {
      productVariantsBulkUpdate(
        productId: $productId,
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

            unitCost {
              amount
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

  const data = await graphql(
    token,
    mutation,
    {
      productId,

      variants: [
        {
          id:
            variantId,

          price:
            String(
              product.price || "0.00"
            ),

          barcode:
            product.barcode
              ? String(product.barcode)
              : null,

          taxable:
            true,

          inventoryItem: {
            sku:
              product.sku || "",

            cost:
              String(
                product.cost || "0.00"
              ),

            tracked:
              true,

            requiresShipping:
              true
          }
        }
      ]
    }
  );

  const output =
    data.productVariantsBulkUpdate;

  if (output.userErrors.length) {
    throw new Error(
      "Variant update failed:\n" +
      JSON.stringify(
        output.userErrors,
        null,
        2
      )
    );
  }

  return output.productVariants[0];
}

// ======================================================
// ACTIVATE INVENTORY AT COMMAND ELITE HQ
// ======================================================

async function activateInventory(
  token,
  inventoryItemId
) {
  const mutation = `
    mutation ActivateInventory(
      $inventoryItemId: ID!,
      $locationId: ID!,
      $idempotencyKey: String!
    ) {
      inventoryActivate(
        inventoryItemId:
          $inventoryItemId,

        locationId:
          $locationId
      )
      @idempotent(
        key: $idempotencyKey
      ) {
        inventoryLevel {
          id
        }

        userErrors {
          field
          message
        }
      }
    }
  `;

  const data = await graphql(
    token,
    mutation,
    {
      inventoryItemId,
      locationId:
        LOCATION_ID,

      idempotencyKey:
        crypto.randomUUID()
    }
  );

  const errors =
    data.inventoryActivate
      .userErrors || [];

  if (errors.length) {
    const alreadyActive =
      errors.every(
        error =>
          error.message
            .toLowerCase()
            .includes("already")
      );

    if (!alreadyActive) {
      throw new Error(
        "Inventory activation failed:\n" +
        JSON.stringify(
          errors,
          null,
          2
        )
      );
    }
  }
}

// ======================================================
// SET HQ INVENTORY
// ======================================================

async function setInventory(
  token,
  inventoryItemId,
  quantity
) {
  const mutation = `
    mutation SetInventory(
      $input:
        InventorySetQuantitiesInput!,

      $idempotencyKey:
        String!
    ) {
      inventorySetQuantities(
        input: $input
      )
      @idempotent(
        key: $idempotencyKey
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

  const data = await graphql(
    token,
    mutation,
    {
      idempotencyKey:
        crypto.randomUUID(),

      input: {
        name:
          "available",

        reason:
          "correction",

        quantities: [
          {
            inventoryItemId,

            locationId:
              LOCATION_ID,

            quantity:
              Number(
                quantity || 0
              ),

            changeFromQuantity:
              null
          }
        ]
      }
    }
  );

  const errors =
    data.inventorySetQuantities
      .userErrors || [];

  if (errors.length) {
    throw new Error(
      "Inventory update failed:\n" +
      JSON.stringify(
        errors,
        null,
        2
      )
    );
  }
}

// ======================================================
// NORMALISE PRODUCT INPUT
// ======================================================

function normaliseProduct(product) {
  const cleaned = {
    ...product
  };

  if (
    Array.isArray(cleaned.tags)
  ) {
    cleaned.tags =
      cleaned.tags
        .map(tag =>
          String(tag).trim()
        )
        .filter(Boolean);
  } else {
    cleaned.tags =
      String(
        cleaned.tags || ""
      )
        .split(",")
        .map(tag =>
          tag.trim()
        )
        .filter(Boolean);
  }

  return cleaned;
}

function normaliseImageUrls(value) {
  if (Array.isArray(value)) {
    return value
      .map(url =>
        String(url).trim()
      )
      .filter(Boolean);
  }

  return String(value || "")
    .split(/\r?\n/)
    .map(url =>
      url.trim()
    )
    .filter(Boolean);
}

// ======================================================
// BASIC VALIDATION
// ======================================================

function validateProduct(product) {
  if (
    !product.title ||
    !String(product.title).trim()
  ) {
    throw new Error(
      "Product title is required."
    );
  }

  if (
    !["DRAFT", "ACTIVE"].includes(
      product.status || "DRAFT"
    )
  ) {
    throw new Error(
      'Status must be "DRAFT" or "ACTIVE".'
    );
  }

  if (
    product.quantity !== undefined &&
    Number.isNaN(
      Number(product.quantity)
    )
  ) {
    throw new Error(
      "Quantity must be a number."
    );
  }
}

// ======================================================
// CREATE COMPLETE SHOPIFY PRODUCT
// ======================================================

async function processProduct({
  product,
  imageSources = []
}) {
  product =
    normaliseProduct(product);

  product.status =
    product.status || "DRAFT";

  validateProduct(product);

  const token =
    await getToken();

  // DUPLICATES FIRST
  const duplicates =
    await checkForDuplicates(
      token,
      product
    );

  if (duplicates.length) {
    return {
      success: false,
      duplicate: true,
      error:
        "POSSIBLE DUPLICATE PRODUCT FOUND",
      duplicates
    };
  }

  // CREATE PRODUCT
  const createdProduct =
    await createProduct(
      token,
      product,
      imageSources
    );

  const variant =
    createdProduct
      .variants
      .nodes[0];

  if (!variant) {
    throw new Error(
      "Shopify did not create a default variant."
    );
  }

  // UPDATE VARIANT
  const updatedVariant =
    await updateVariant(
      token,
      createdProduct.id,
      variant.id,
      product
    );

  const inventoryItemId =
    updatedVariant
      .inventoryItem.id;

  // INVENTORY
  await activateInventory(
    token,
    inventoryItemId
  );

  await setInventory(
    token,
    inventoryItemId,
    product.quantity
  );

  return {
    success: true,

    title:
      createdProduct.title,

    status:
      createdProduct.status,

    productId:
      createdProduct.id,

    handle:
      createdProduct.handle,

    sku:
      updatedVariant
        .inventoryItem
        .sku,

    price:
      updatedVariant.price,

    barcode:
      updatedVariant.barcode,

    quantity:
      Number(
        product.quantity || 0
      ),

    location:
      "Command Elite HQ",

    images:
      imageSources.length
  };
}

// ======================================================
// HEALTH CHECK
// ======================================================

app.get(
  "/healthz",
  (req, res) => {
    res.status(200).json({
      ok: true,
      service:
        "Command Elite Shopify Uploader"
    });
  }
);

// ======================================================
// PUBLIC HOME PAGE
// ======================================================

app.get(
  "/",
  (req, res) => {
    res.sendFile(
      path.join(
        __dirname,
        "index.html"
      )
    );
  }
);

// ======================================================
// SECURE BROWSER UPLOAD ROUTE
// ======================================================
// This route accepts multipart/form-data and local files.
// It now requires the Bearer API key.

app.post(
  "/upload",

  requireApiKey,

  upload.array(
    "photos",
    10
  ),

  async (req, res) => {
    try {
      const product =
        normaliseProduct(
          req.body
        );

      const imageUrls =
        normaliseImageUrls(
          product.imageUrls
        );

      const token =
        await getToken();

      // Check duplicates before uploading local files
      const duplicates =
        await checkForDuplicates(
          token,
          product
        );

      if (duplicates.length) {
        return res
          .status(409)
          .json({
            success: false,
            duplicate: true,
            error:
              "POSSIBLE DUPLICATE PRODUCT FOUND",
            duplicates
          });
      }

      const localImages = [];

      for (
        const file of req.files || []
      ) {
        const source =
          await stageImage(
            token,
            file
          );

        localImages.push(
          source
        );
      }

      const allImageSources = [
        ...localImages,
        ...imageUrls
      ];

      const createdProduct =
        await createProduct(
          token,
          product,
          allImageSources
        );

      const variant =
        createdProduct
          .variants
          .nodes[0];

      if (!variant) {
        throw new Error(
          "Shopify did not create a default variant."
        );
      }

      const updatedVariant =
        await updateVariant(
          token,
          createdProduct.id,
          variant.id,
          product
        );

      const inventoryItemId =
        updatedVariant
          .inventoryItem.id;

      await activateInventory(
        token,
        inventoryItemId
      );

      await setInventory(
        token,
        inventoryItemId,
        product.quantity
      );

      res.json({
        success: true,
        title:
          createdProduct.title,
        status:
          createdProduct.status,
        productId:
          createdProduct.id,
        sku:
          updatedVariant
            .inventoryItem
            .sku,
        quantity:
          Number(
            product.quantity || 0
          ),
        location:
          "Command Elite HQ",
        images:
          allImageSources.length
      });

    } catch (error) {
      console.error(error);

      res.status(500).json({
        success: false,
        error:
          error.message
      });
    }
  }
);

// ======================================================
// SECURE JSON API FOR CHATGPT
// ======================================================
// This is the endpoint we'll connect to ChatGPT.
// It accepts product data + public/staged image URLs.
// No local browser uploader is required.

app.post(
  "/api/upload-product",

  requireApiKey,

  async (req, res) => {
    try {
      const product =
        normaliseProduct(
          req.body || {}
        );

      const imageSources =
        normaliseImageUrls(
          product.imageUrls ||
          product.images
        );

      const result =
        await processProduct({
          product,
          imageSources
        });

      if (
        result.duplicate
      ) {
        return res
          .status(409)
          .json(result);
      }

      res.status(200).json(
        result
      );

    } catch (error) {
      console.error(error);

      res.status(500).json({
        success: false,
        error:
          error.message
      });
    }
  }
);

// ======================================================
// 404
// ======================================================

app.use(
  (req, res) => {
    res.status(404).json({
      success: false,
      error: "Not found"
    });
  }
);

// ======================================================
// START SERVER
// ======================================================

app.listen(
  PORT,
  "0.0.0.0",
  () => {
    console.log("");
    console.log(
      "===================================="
    );
    console.log(
      "COMMAND ELITE SHOPIFY UPLOADER"
    );
    console.log(
      "===================================="
    );
    console.log(
      `Running on port ${PORT}`
    );
    console.log(
      "API security: ON"
    );
    console.log(
      "Duplicate protection: ON"
    );
    console.log(
      "ChatGPT endpoint: /api/upload-product"
    );
    console.log("");
  }
);

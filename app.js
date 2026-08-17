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

const shop = process.env.SHOPIFY_SHOP;
const clientId = process.env.SHOPIFY_CLIENT_ID;
const clientSecret = process.env.SHOPIFY_CLIENT_SECRET;

const LOCATION_ID = "gid://shopify/Location/15027437646";
const PORT = 3030;

app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

// ======================================================
// AUTHENTICATION
// ======================================================

async function getToken() {
  const response = await fetch(
    `https://${shop}/admin/oauth/access_token`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
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
      "Authentication failed:\n" +
      JSON.stringify(data, null, 2)
    );
  }

  return data.access_token;
}

// ======================================================
// GRAPHQL HELPER
// ======================================================

async function graphql(token, query, variables = {}) {
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
      "GraphQL error:\n" +
      JSON.stringify(result.errors, null, 2)
    );
  }

  return result.data;
}

// ======================================================
// SAFE SHOPIFY SEARCH VALUE
// ======================================================

function escapeSearchValue(value) {
  return String(value || "")
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"');
}

// ======================================================
// DUPLICATE CHECK
// ======================================================

async function checkForDuplicates(token, product) {
  const duplicateResults = [];

  // ------------------------------------------------------
  // SKU CHECK
  // ------------------------------------------------------

  if (product.sku && product.sku.trim()) {
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

    const data = await graphql(
      token,
      query,
      {
        query:
          `sku:"${escapeSearchValue(product.sku.trim())}"`
      }
    );

    const exactSkuMatches =
      data.productVariants.nodes.filter(
        variant =>
          String(variant.sku || "")
            .trim()
            .toLowerCase() ===
          product.sku.trim().toLowerCase()
      );

    for (const match of exactSkuMatches) {
      duplicateResults.push({
        type: "SKU",
        value: product.sku.trim(),
        productTitle: match.product.title,
        productStatus: match.product.status
      });
    }
  }

  // ------------------------------------------------------
  // BARCODE CHECK
  // ------------------------------------------------------

  if (
    product.barcode &&
    product.barcode.trim()
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

    const data = await graphql(
      token,
      query,
      {
        query:
          `barcode:"${escapeSearchValue(
            product.barcode.trim()
          )}"`
      }
    );

    const exactBarcodeMatches =
      data.productVariants.nodes.filter(
        variant =>
          String(variant.barcode || "")
            .trim() ===
          product.barcode.trim()
      );

    for (
      const match of exactBarcodeMatches
    ) {
      duplicateResults.push({
        type: "BARCODE",
        value: product.barcode.trim(),
        productTitle: match.product.title,
        productStatus: match.product.status
      });
    }
  }

  // ------------------------------------------------------
  // TITLE CHECK
  // ------------------------------------------------------

  if (
    product.title &&
    product.title.trim()
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

    const data = await graphql(
      token,
      query,
      {
        query:
          `title:"${escapeSearchValue(
            product.title.trim()
          )}"`
      }
    );

    const exactTitleMatches =
      data.products.nodes.filter(
        existing =>
          existing.title
            .trim()
            .toLowerCase() ===
          product.title
            .trim()
            .toLowerCase()
      );

    for (
      const match of exactTitleMatches
    ) {
      duplicateResults.push({
        type: "TITLE",
        value: product.title.trim(),
        productTitle: match.title,
        productStatus: match.status
      });
    }
  }

  return duplicateResults;
}

// ======================================================
// STAGE LOCAL IMAGE
// ======================================================

async function stageImage(token, file) {
  const mutation = `
    mutation StagedUploadsCreate(
      $input: [StagedUploadInput!]!
    ) {
      stagedUploadsCreate(input: $input) {
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
          filename: file.originalname,
          mimeType: file.mimetype,
          httpMethod: "POST",
          resource: "PRODUCT_IMAGE"
        }
      ]
    }
  );

  const output =
    data.stagedUploadsCreate;

  if (output.userErrors.length) {
    throw new Error(
      "Staged upload failed:\n" +
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

  const response = await fetch(
    target.url,
    {
      method: "POST",
      body: form
    }
  );

  if (!response.ok) {
    const text =
      await response.text();

    throw new Error(
      `Image upload failed (${response.status}):\n${text}`
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

          variants(first: 1) {
            nodes {
              id

              inventoryItem {
                id
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
    imageSources.map(
      source => ({
        originalSource: source,
        mediaContentType: "IMAGE",
        alt: product.title
      })
    );

  const data = await graphql(
    token,
    mutation,
    {
      product: {
        title: product.title,

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
// UPDATE VARIANT
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

          inventoryItem {
            id
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
          id: variantId,

          price:
            String(
              product.price || "0.00"
            ),

          barcode:
            product.barcode || null,

          taxable: true,

          inventoryItem: {
            sku:
              product.sku || "",

            cost:
              String(
                product.cost || "0.00"
              ),

            tracked: true,

            requiresShipping: true
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
// ACTIVATE INVENTORY
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
        inventoryItemId: $inventoryItemId,
        locationId: $locationId
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
      locationId: LOCATION_ID,
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
// SET INVENTORY
// ======================================================

async function setInventory(
  token,
  inventoryItemId,
  quantity
) {
  const mutation = `
    mutation SetInventory(
      $input: InventorySetQuantitiesInput!,
      $idempotencyKey: String!
    ) {
      inventorySetQuantities(
        input: $input
      )
      @idempotent(
        key: $idempotencyKey
      ) {
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
        name: "available",
        reason: "correction",

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
// SERVE FORM
// ======================================================

app.get("/", (req, res) => {
  res.sendFile(
    path.join(
      __dirname,
      "index.html"
    )
  );
});

// ======================================================
// UPLOAD PRODUCT
// ======================================================

app.post(
  "/upload",

  upload.array(
    "photos",
    10
  ),

  async (req, res) => {
    try {
      const product =
        req.body;

      // TAGS

      product.tags =
        String(
          product.tags || ""
        )
          .split(",")
          .map(
            tag =>
              tag.trim()
          )
          .filter(Boolean);

      // IMAGE URLS

      const imageUrls =
        String(
          product.imageUrls || ""
        )
          .split(/\r?\n/)
          .map(
            url =>
              url.trim()
          )
          .filter(Boolean);

      // AUTHENTICATE FIRST

      const token =
        await getToken();

      // ==================================================
      // DUPLICATE CHECK BEFORE UPLOAD
      // ==================================================

      const duplicates =
        await checkForDuplicates(
          token,
          product
        );

      if (duplicates.length) {
        return res.status(409).json({
          success: false,
          duplicate: true,

          error:
            "POSSIBLE DUPLICATE PRODUCT FOUND",

          duplicates
        });
      }

      // ==================================================
      // LOCAL IMAGES
      // ==================================================

      const localImageSources = [];

      for (
        const file of req.files || []
      ) {
        const source =
          await stageImage(
            token,
            file
          );

        localImageSources.push(
          source
        );
      }

      const allImageSources = [
        ...localImageSources,
        ...imageUrls
      ];

      // ==================================================
      // CREATE PRODUCT
      // ==================================================

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

      // ==================================================
      // PRICE / SKU / BARCODE / COST
      // ==================================================

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

      // ==================================================
      // INVENTORY
      // ==================================================

      await activateInventory(
        token,
        inventoryItemId
      );

      await setInventory(
        token,
        inventoryItemId,
        product.quantity
      );

      // ==================================================
      // SUCCESS
      // ==================================================

      res.json({
        success: true,

        title:
          createdProduct.title,

        status:
          createdProduct.status,

        images:
          allImageSources.length
      });

    } catch (error) {
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }
);

// ======================================================
// START SERVER
// ======================================================

app.listen(PORT, () => {
  console.log("");
  console.log(
    "COMMAND ELITE SHOPIFY UPLOADER"
  );

  console.log(
    `Running at http://localhost:${PORT}`
  );

  console.log("");
  console.log(
    "Duplicate protection: ON"
  );
  console.log("");
});
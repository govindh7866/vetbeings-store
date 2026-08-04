const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const Razorpay = require("razorpay");
const multer = require("multer");
const { v2: cloudinary } = require("cloudinary");

const app = express();

/* =========================
   BASIC SETUP
========================= */

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(__dirname));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

const PF = path.join(__dirname, "products.json");
const OF = path.join(__dirname, "orders.json");

const read = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    return [];
  }
};

const write = (file, data) => {
  fs.writeFileSync(
    file,
    JSON.stringify(data, null, 2)
  );
};

/* =========================
   CLOUDINARY
========================= */

cloudinary.config({
  cloud_name:
    process.env.CLOUDINARY_CLOUD_NAME,

  api_key:
    process.env.CLOUDINARY_API_KEY,

  api_secret:
    process.env.CLOUDINARY_API_SECRET
});

const upload = multer({
  storage: multer.memoryStorage(),

  limits: {
    fileSize: 5 * 1024 * 1024
  },

  fileFilter: (req, file, cb) => {
    if (
      file.mimetype &&
      file.mimetype.startsWith("image/")
    ) {
      cb(null, true);
    } else {
      cb(
        new Error(
          "Only image files are allowed."
        )
      );
    }
  }
});

function uploadToCloudinary(buffer) {
  return new Promise(
    (resolve, reject) => {

      const stream =
        cloudinary.uploader.upload_stream(
          {
            folder:
              "vetbeings/products",

            resource_type:
              "image"
          },

          (error, result) => {

            if (error) {
              reject(error);
            } else {
              resolve(result);
            }

          }
        );

      stream.end(buffer);
    }
  );
}

/* =========================
   ADMIN SECURITY
========================= */

const adminAuth = (
  req,
  res,
  next
) => {

  if (
    !process.env.ADMIN_PASSWORD
  ) {
    return res.status(503).json({
      error:
        "ADMIN_PASSWORD not configured"
    });
  }

  const expected =
    "Bearer " +
    process.env.ADMIN_PASSWORD;

  if (
    req.headers.authorization !==
    expected
  ) {
    return res.status(401).json({
      error: "Unauthorized"
    });
  }

  next();
};

/* =========================
   PRODUCTS - CUSTOMER
========================= */

app.get(
  "/api/products",
  (req, res) => {

    try {

      const products =
        read(PF);

      res.set(
        "Cache-Control",
        "no-store"
      );

      res.json(products);

    } catch (e) {

      res.status(500).json({
        error:
          "Products could not load."
      });

    }
  }
);

/* =========================
   ADD / EDIT PRODUCT
========================= */

app.post(
  "/api/admin/products",

  adminAuth,

  upload.single("image"),

  async (req, res) => {

    try {

      let products =
        read(PF);

      const existingId =
        req.body.id
          ? Number(req.body.id)
          : null;

      const product = {

        id:
          existingId ||
          Date.now(),

        name:
          String(
            req.body.name || ""
          ).trim(),

        category:
          String(
            req.body.category || ""
          ).trim(),

        description:
          String(
            req.body.description || ""
          ).trim(),

        price:
          Number(
            req.body.price || 0
          ),

        stock:
          Number(
            req.body.stock || 0
          )
      };

      /* BASIC VALIDATION */

      if (!product.name) {
        return res
          .status(400)
          .json({
            error:
              "Product name is required."
          });
      }

      if (
        !Number.isFinite(
          product.price
        ) ||
        product.price < 0
      ) {
        return res
          .status(400)
          .json({
            error:
              "Invalid product price."
          });
      }

      if (
        !Number.isFinite(
          product.stock
        ) ||
        product.stock < 0
      ) {
        return res
          .status(400)
          .json({
            error:
              "Invalid stock quantity."
          });
      }

      /* FIND OLD PRODUCT */

      const index =
        products.findIndex(
          (x) =>
            Number(x.id) ===
            Number(product.id)
        );

      const oldProduct =
        index >= 0
          ? products[index]
          : null;

      /* =========================
         IMAGE UPLOAD
      ========================= */

      if (req.file) {

        const result =
          await uploadToCloudinary(
            req.file.buffer
          );

        product.image =
          result.secure_url;

        product.imagePublicId =
          result.public_id;

        /*
          Delete old Cloudinary image
          only after new upload succeeds
        */

        if (
          oldProduct &&
          oldProduct.imagePublicId
        ) {

          try {

            await cloudinary
              .uploader
              .destroy(
                oldProduct
                  .imagePublicId
              );

          } catch (e) {

            console.error(
              "Old image delete error:",
              e.message
            );

          }
        }

      } else if (oldProduct) {

        /*
          Editing without selecting
          a new photo:
          keep old photo.
        */

        if (
          oldProduct.image
        ) {
          product.image =
            oldProduct.image;
        }

        if (
          oldProduct.imagePublicId
        ) {
          product.imagePublicId =
            oldProduct
              .imagePublicId;
        }
      }

      /* =========================
         SAVE PRODUCT
      ========================= */

      if (index >= 0) {

        products[index] = {
          ...oldProduct,
          ...product
        };

      } else {

        products.push(product);

      }

      write(PF, products);

      res.json({
        ok: true,
        product:
          index >= 0
            ? products[index]
            : product
      });

    } catch (e) {

      console.error(
        "Product save error:",
        e
      );

      res.status(500).json({
        error:
          e.message ||
          "Product could not be saved."
      });
    }
  }
);

/* =========================
   DELETE PRODUCT
========================= */

app.delete(
  "/api/admin/products/:id",

  adminAuth,

  async (req, res) => {

    try {

      let products =
        read(PF);

      const product =
        products.find(
          (x) =>
            String(x.id) ===
            String(req.params.id)
        );

      if (!product) {

        return res
          .status(404)
          .json({
            error:
              "Product not found."
          });
      }

      /*
        Delete product image
        from Cloudinary
      */

      if (
        product.imagePublicId
      ) {

        try {

          await cloudinary
            .uploader
            .destroy(
              product
                .imagePublicId
            );

        } catch (e) {

          console.error(
            "Cloudinary delete error:",
            e.message
          );

        }
      }

      products =
        products.filter(
          (x) =>
            String(x.id) !==
            String(req.params.id)
        );

      write(PF, products);

      res.json({
        ok: true
      });

    } catch (e) {

      console.error(
        "Delete product error:",
        e
      );

      res.status(500).json({
        error:
          e.message ||
          "Product could not be deleted."
      });
    }
  }
);

/* =========================
   ADMIN ORDERS
========================= */

app.get(
  "/api/admin/orders",

  adminAuth,

  (req, res) => {

    try {

      res.set(
        "Cache-Control",
        "no-store"
      );

      res.json(
        read(OF)
      );

    } catch (e) {

      res.status(500).json({
        error:
          "Orders could not load."
      });

    }
  }
);

/* =========================
   CASH ON DELIVERY ORDER
========================= */

app.post(
  "/api/orders",

  (req, res) => {

    try {

      const orders =
        read(OF);

      const {
        customer,
        items,
        total
      } = req.body;

      if (
        !customer ||
        !customer.name ||
        !customer.mobile ||
        !customer.address
      ) {

        return res
          .status(400)
          .json({
            error:
              "Customer details are required."
          });
      }

      if (
        !Array.isArray(items) ||
        !items.length
      ) {

        return res
          .status(400)
          .json({
            error:
              "Order has no products."
          });
      }

      const order = {

        id:
          "VB" +
          Date.now(),

        time:
          new Date()
            .toISOString(),

        status:
          "pending",

        payment:
          "COD",

        customer,

        items,

        total:
          Number(total || 0)
      };

      orders.unshift(order);

      write(
        OF,
        orders
      );

      res.json(order);

    } catch (e) {

      console.error(
        "COD order error:",
        e
      );

      res.status(500).json({
        error:
          e.message ||
          "Order could not be created."
      });
    }
  }
);

/* =========================
   RAZORPAY CREATE ORDER
========================= */

app.post(
  "/api/payment/order",

  async (req, res) => {

    try {

      if (
        !process.env
          .RAZORPAY_KEY_ID ||
        !process.env
          .RAZORPAY_KEY_SECRET
      ) {

        return res
          .status(503)
          .json({
            error:
              "Razorpay keys not configured."
          });
      }

      const amount =
        Number(
          req.body.amount
        );

      if (
        !Number.isFinite(amount) ||
        amount <= 0
      ) {

        return res
          .status(400)
          .json({
            error:
              "Invalid payment amount."
          });
      }

      const razorpay =
        new Razorpay({

          key_id:
            process.env
              .RAZORPAY_KEY_ID,

          key_secret:
            process.env
              .RAZORPAY_KEY_SECRET
        });

      const order =
        await razorpay
          .orders
          .create({

            amount:
              Math.round(
                amount * 100
              ),

            currency:
              "INR",

            receipt:
              "vb_" +
              Date.now()
          });

      res.json({

        order,

        key:
          process.env
            .RAZORPAY_KEY_ID
      });

    } catch (e) {

      console.error(
        "Razorpay order error:",
        e
      );

      res.status(500).json({
        error:
          e.message ||
          "Payment order could not be created."
      });
    }
  }
);

/* =========================
   VERIFY RAZORPAY PAYMENT
========================= */

app.post(
  "/api/payment/verify",

  (req, res) => {

    try {

      const {
        razorpay_order_id,
        razorpay_payment_id,
        razorpay_signature,
        customer,
        items,
        total
      } = req.body;

      if (
        !process.env
          .RAZORPAY_KEY_SECRET
      ) {

        return res
          .status(503)
          .json({
            error:
              "Razorpay secret not configured."
          });
      }

      if (
        !razorpay_order_id ||
        !razorpay_payment_id ||
        !razorpay_signature
      ) {

        return res
          .status(400)
          .json({
            error:
              "Payment details missing."
          });
      }

      const expected =
        crypto
          .createHmac(
            "sha256",
            process.env
              .RAZORPAY_KEY_SECRET
          )
          .update(
            razorpay_order_id +
            "|" +
            razorpay_payment_id
          )
          .digest("hex");

      if (
        expected !==
        razorpay_signature
      ) {

        return res
          .status(400)
          .json({
            error:
              "Invalid payment signature."
          });
      }

      const orders =
        read(OF);

      const order = {

        id:
          "VB" +
          Date.now(),

        time:
          new Date()
            .toISOString(),

        status:
          "paid",

        payment:
          "Razorpay",

        paymentId:
          razorpay_payment_id,

        razorpayOrderId:
          razorpay_order_id,

        customer,

        items,

        total:
          Number(total || 0)
      };

      orders.unshift(order);

      write(
        OF,
        orders
      );

      res.json({
        ok: true,
        order
      });

    } catch (e) {

      console.error(
        "Payment verify error:",
        e
      );

      res.status(500).json({
        error:
          e.message ||
          "Payment verification failed."
      });
    }
  }
);

/* =========================
   ERROR HANDLER
========================= */

app.use(
  (err, req, res, next) => {

    console.error(
      "Server error:",
      err
    );

    res.status(500).json({
      error:
        err.message ||
        "Server error."
    });
  }
);

/* =========================
   SERVER
========================= */

const PORT =
  process.env.PORT ||
  3000;

app.listen(
  PORT,
  () => {

    console.log(
      "VetBeings running on port " +
      PORT
    );

  }
);

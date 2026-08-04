const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const Razorpay = require("razorpay");
const multer = require("multer");
const { v2: cloudinary } = require("cloudinary");

const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(__dirname));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

/* =========================
   FILES
========================= */

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
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 5 * 1024 * 1024
  }
});

function uploadToCloudinary(buffer) {
  return new Promise((resolve, reject) => {

    const stream = cloudinary.uploader.upload_stream(
      {
        folder: "vetbeings/products",
        resource_type: "image"
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

  });
}

/* =========================
   ADMIN SECURITY
========================= */

const adminAuth = (req, res, next) => {

  if (!process.env.ADMIN_PASSWORD) {
    return res.status(503).json({
      error: "ADMIN_PASSWORD not configured"
    });
  }

  if (
    req.headers.authorization !==
    "Bearer " + process.env.ADMIN_PASSWORD
  ) {
    return res.status(401).json({
      error: "Unauthorized"
    });
  }

  next();
};

/* =========================
   PRODUCTS
========================= */

/* CUSTOMER PRODUCT LIST */

app.get("/api/products", (req, res) => {

  const products = read(PF);

  res.json(products);

});

/* =========================
   ADD / EDIT PRODUCT
========================= */

app.post(
  "/api/admin/products",
  adminAuth,
  upload.single("image"),
  async (req, res) => {

    try {

      let products = read(PF);

      const product = {

        id: req.body.id
          ? Number(req.body.id)
          : Date.now(),

        name:
          String(req.body.name || "").trim(),

        category:
          String(req.body.category || "").trim(),

        description:
          String(req.body.description || "").trim(),

        price:
          Number(req.body.price || 0),

        stock:
          Number(req.body.stock || 0)

      };

      /* BASIC VALIDATION */

      if (!product.name) {
        return res.status(400).json({
          error: "Product name is required"
        });
      }

      if (product.price < 0) {
        return res.status(400).json({
          error: "Invalid product price"
        });
      }

      if (product.stock < 0) {
        return res.status(400).json({
          error: "Invalid product stock"
        });
      }

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

      }

      const index =
        products.findIndex(
          (item) =>
            String(item.id) ===
            String(product.id)
        );

      /* =========================
         EDIT EXISTING PRODUCT
      ========================= */

      if (index >= 0) {

        /*
          Agar edit karte waqt new photo
          upload nahi hui to old photo
          preserve hogi.
        */

        if (
          !product.image &&
          products[index].image
        ) {

          product.image =
            products[index].image;

          product.imagePublicId =
            products[index].imagePublicId;

        }

        products[index] = {
          ...products[index],
          ...product
        };

      }

      /* =========================
         ADD NEW PRODUCT
      ========================= */

      else {

        products.push(product);

      }

      write(PF, products);

      res.json({
        ok: true,
        product
      });

    } catch (e) {

      console.error(
        "Product save error:",
        e
      );

      res.status(500).json({
        error:
          e.message ||
          "Unable to save product"
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

      let products = read(PF);

      const product =
        products.find(
          (item) =>
            String(item.id) ===
            String(req.params.id)
        );

      if (!product) {

        return res.status(404).json({
          error: "Product not found"
        });

      }

      /* DELETE CLOUDINARY PHOTO */

      if (product.imagePublicId) {

        try {

          await cloudinary.uploader.destroy(
            product.imagePublicId
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
          (item) =>
            String(item.id) !==
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
          "Unable to delete product"
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

    const orders = read(OF);

    res.json(orders);

  }
);

/* =========================
   CASH ON DELIVERY ORDER
========================= */

app.post("/api/orders", (req, res) => {

  try {

    const orders = read(OF);

    const order = {

      id:
        "VB" + Date.now(),

      time:
        new Date().toISOString(),

      status:
        "pending",

      payment:
        "COD",

      ...req.body

    };

    orders.unshift(order);

    write(OF, orders);

    res.json(order);

  } catch (e) {

    console.error(
      "COD order error:",
      e
    );

    res.status(500).json({
      error:
        e.message ||
        "Unable to create order"
    });

  }

});

/* =========================
   RAZORPAY CREATE ORDER
========================= */

app.post(
  "/api/payment/order",
  async (req, res) => {

    try {

      if (
        !process.env.RAZORPAY_KEY_ID ||
        !process.env.RAZORPAY_KEY_SECRET
      ) {

        return res.status(503).json({
          error:
            "Razorpay keys not configured."
        });

      }

      const amount =
        Number(req.body.amount || 0);

      if (
        !Number.isFinite(amount) ||
        amount <= 0
      ) {

        return res.status(400).json({
          error:
            "Invalid payment amount."
        });

      }

      const razorpay =
        new Razorpay({

          key_id:
            process.env.RAZORPAY_KEY_ID,

          key_secret:
            process.env.RAZORPAY_KEY_SECRET

        });

      const order =
        await razorpay.orders.create({

          amount:
            Math.round(
              amount * 100
            ),

          currency:
            "INR",

          receipt:
            "vb_" + Date.now()

        });

      res.json({

        order,

        key:
          process.env.RAZORPAY_KEY_ID

      });

    } catch (e) {

      console.error(
        "Razorpay order error:",
        e
      );

      res.status(500).json({
        error:
          e.message ||
          "Unable to create payment order"
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
        !process.env.RAZORPAY_KEY_SECRET
      ) {

        return res.status(503).json({
          error:
            "Razorpay secret not configured."
        });

      }

      if (
        !razorpay_order_id ||
        !razorpay_payment_id ||
        !razorpay_signature
      ) {

        return res.status(400).json({
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

        return res.status(400).json({
          error:
            "Invalid payment signature"
        });

      }

      const orders = read(OF);

      const order = {

        id:
          "VB" + Date.now(),

        time:
          new Date().toISOString(),

        status:
          "paid",

        payment:
          "Razorpay",

        paymentId:
          razorpay_payment_id,

        customer,

        items,

        total

      };

      orders.unshift(order);

      write(OF, orders);

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
          "Payment verification failed"
      });

    }

  }
);

/* =========================
   SERVER
========================= */

const PORT =
  process.env.PORT || 3000;

app.listen(PORT, () => {

  console.log(
    "VetBeings running on port " +
    PORT
  );

});

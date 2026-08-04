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
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
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
  },
  fileFilter: (req, file, cb) => {
    if (
      file.mimetype &&
      file.mimetype.startsWith("image/")
    ) {
      cb(null, true);
    } else {
      cb(new Error("Only image files are allowed."));
    }
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
        if (error) reject(error);
        else resolve(result);
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

app.get("/api/products", (req, res) => {
  res.set("Cache-Control", "no-store");
  res.json(read(PF));
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

        name: String(
          req.body.name || ""
        ).trim(),

        category: String(
          req.body.category || ""
        ).trim(),

        description: String(
          req.body.description || ""
        ).trim(),

        price: Number(
          req.body.price || 0
        ),

        stock: Number(
          req.body.stock || 0
        )
      };

      if (!product.name) {
        return res.status(400).json({
          error: "Product name is required."
        });
      }

      if (
        !Number.isFinite(product.price) ||
        product.price < 0
      ) {
        return res.status(400).json({
          error: "Invalid product price."
        });
      }

      if (
        !Number.isFinite(product.stock) ||
        product.stock < 0
      ) {
        return res.status(400).json({
          error: "Invalid stock quantity."
        });
      }

      const index = products.findIndex(
        (x) =>
          Number(x.id) ===
          Number(product.id)
      );

      const oldProduct =
        index >= 0
          ? products[index]
          : null;

      if (req.file) {
        const result =
          await uploadToCloudinary(
            req.file.buffer
          );

        product.image =
          result.secure_url;

        product.imagePublicId =
          result.public_id;

        if (
          oldProduct &&
          oldProduct.imagePublicId
        ) {
          try {
            await cloudinary.uploader.destroy(
              oldProduct.imagePublicId
            );
          } catch (e) {
            console.error(
              "Old image delete error:",
              e.message
            );
          }
        }
      } else if (oldProduct) {
        if (oldProduct.image) {
          product.image =
            oldProduct.image;
        }

        if (oldProduct.imagePublicId) {
          product.imagePublicId =
            oldProduct.imagePublicId;
        }
      }

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
      console.error(e);

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
      let products = read(PF);

      const product =
        products.find(
          (x) =>
            String(x.id) ===
            String(req.params.id)
        );

      if (!product) {
        return res.status(404).json({
          error: "Product not found."
        });
      }

      if (product.imagePublicId) {
        try {
          await cloudinary.uploader.destroy(
            product.imagePublicId
          );
        } catch (e) {
          console.error(
            "Image delete error:",
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
      res.status(500).json({
        error: e.message
      });
    }
  }
);

/* =========================
   STOCK FUNCTIONS
========================= */

function checkAndReduceStock(items) {
  let products = read(PF);

  if (
    !Array.isArray(items) ||
    !items.length
  ) {
    throw new Error(
      "Order has no products."
    );
  }

  /* FIRST CHECK ALL STOCK */

  for (const item of items) {
    const product =
      products.find(
        (p) =>
          Number(p.id) ===
          Number(item.id)
      );

    if (!product) {
      throw new Error(
        "Product not found: " +
        (item.name || item.id)
      );
    }

    const qty =
      Number(item.qty || 0);

    if (
      !Number.isInteger(qty) ||
      qty <= 0
    ) {
      throw new Error(
        "Invalid product quantity."
      );
    }

    if (
      Number(product.stock || 0) <
      qty
    ) {
      throw new Error(
        product.name +
        " has only " +
        Number(product.stock || 0) +
        " in stock."
      );
    }
  }

  /* REDUCE ONLY AFTER ALL CHECKS PASS */

  for (const item of items) {
    const product =
      products.find(
        (p) =>
          Number(p.id) ===
          Number(item.id)
      );

    product.stock =
      Number(product.stock || 0) -
      Number(item.qty || 0);
  }

  write(PF, products);
}

function restoreStock(items) {
  let products = read(PF);

  if (!Array.isArray(items)) {
    return;
  }

  for (const item of items) {
    const product =
      products.find(
        (p) =>
          Number(p.id) ===
          Number(item.id)
      );

    if (product) {
      product.stock =
        Number(product.stock || 0) +
        Number(item.qty || 0);
    }
  }

  write(PF, products);
}

/* =========================
   ADMIN ORDERS
========================= */

app.get(
  "/api/admin/orders",
  adminAuth,
  (req, res) => {
    res.set(
      "Cache-Control",
      "no-store"
    );

    res.json(read(OF));
  }
);

/* =========================
   UPDATE ORDER STATUS
========================= */

app.patch(
  "/api/admin/orders/:id/status",
  adminAuth,
  (req, res) => {
    try {
      const allowed = [
        "pending",
        "confirmed",
        "shipped",
        "delivered",
        "cancelled"
      ];

      const newStatus =
        String(
          req.body.status || ""
        ).toLowerCase();

      if (
        !allowed.includes(newStatus)
      ) {
        return res.status(400).json({
          error:
            "Invalid order status."
        });
      }

      const orders = read(OF);

      const index =
        orders.findIndex(
          (o) =>
            String(o.id) ===
            String(req.params.id)
        );

      if (index < 0) {
        return res.status(404).json({
          error:
            "Order not found."
        });
      }

      const order =
        orders[index];

      const oldStatus =
        order.status || "pending";

      /*
        If an active order is cancelled,
        return items to stock.
      */

      if (
        newStatus === "cancelled" &&
        oldStatus !== "cancelled"
      ) {
        restoreStock(
          order.items
        );

        order.stockRestored =
          true;
      }

      /*
        If cancelled order becomes active
        again, reduce stock again.
      */

      if (
        oldStatus === "cancelled" &&
        newStatus !== "cancelled"
      ) {
        checkAndReduceStock(
          order.items
        );

        order.stockRestored =
          false;
      }

      order.status =
        newStatus;

      order.statusUpdatedAt =
        new Date().toISOString();

      orders[index] =
        order;

      write(OF, orders);

      res.json({
        ok: true,
        order
      });
    } catch (e) {
      res.status(400).json({
        error:
          e.message ||
          "Status update failed."
      });
    }
  }
);

/* =========================
   COD ORDER
========================= */

app.post(
  "/api/orders",
  (req, res) => {
    try {
      const {
        customer,
        items
      } = req.body;

      if (
        !customer ||
        !customer.name ||
        !customer.mobile ||
        !customer.address
      ) {
        return res.status(400).json({
          error:
            "Customer details are required."
        });
      }

      /*
        IMPORTANT:
        Server calculates total itself.
        Do not trust customer browser price.
      */

      const products = read(PF);

      let calculatedTotal = 0;

      const safeItems =
        items.map((item) => {
          const p =
            products.find(
              (x) =>
                Number(x.id) ===
                Number(item.id)
            );

          if (!p) {
            throw new Error(
              "Product not found."
            );
          }

          const qty =
            Number(item.qty || 0);

          if (
            !Number.isInteger(qty) ||
            qty <= 0
          ) {
            throw new Error(
              "Invalid quantity."
            );
          }

          calculatedTotal +=
            Number(p.price || 0) *
            qty;

          return {
            id: p.id,
            name: p.name,
            price:
              Number(p.price || 0),
            qty
          };
        });

      checkAndReduceStock(
        safeItems
      );

      const orders = read(OF);

      const order = {
        id:
          "VB" +
          Date.now(),

        time:
          new Date().toISOString(),

        status:
          "pending",

        payment:
          "COD",

        customer,

        items:
          safeItems,

        total:
          calculatedTotal,

        stockRestored:
          false
      };

      orders.unshift(order);

      try {
        write(OF, orders);
      } catch (e) {
        /*
          If order save fails,
          restore stock.
        */
        restoreStock(
          safeItems
        );

        throw e;
      }

      res.json(order);
    } catch (e) {
      console.error(
        "COD error:",
        e
      );

      res.status(400).json({
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
        !process.env.RAZORPAY_KEY_ID ||
        !process.env.RAZORPAY_KEY_SECRET
      ) {
        return res.status(503).json({
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
            "vb_" +
            Date.now()
        });

      res.json({
        order,
        key:
          process.env.RAZORPAY_KEY_ID
      });
    } catch (e) {
      console.error(e);

      res.status(500).json({
        error:
          e.message ||
          "Payment order failed."
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
        items
      } = req.body;

      if (
        !process.env
          .RAZORPAY_KEY_SECRET
      ) {
        return res.status(503).json({
          error:
            "Razorpay secret not configured."
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
            "Invalid payment signature."
        });
      }

      /*
        Prevent duplicate payment
        verification/order creation.
      */

      const existingOrders =
        read(OF);

      const duplicate =
        existingOrders.find(
          (o) =>
            o.paymentId ===
            razorpay_payment_id
        );

      if (duplicate) {
        return res.json({
          ok: true,
          order: duplicate
        });
      }

      /*
        Calculate products and total
        from server data.
      */

      const products =
        read(PF);

      let calculatedTotal = 0;

      const safeItems =
        items.map((item) => {
          const p =
            products.find(
              (x) =>
                Number(x.id) ===
                Number(item.id)
            );

          if (!p) {
            throw new Error(
              "Product not found."
            );
          }

          const qty =
            Number(item.qty || 0);

          if (
            !Number.isInteger(qty) ||
            qty <= 0
          ) {
            throw new Error(
              "Invalid quantity."
            );
          }

          calculatedTotal +=
            Number(p.price || 0) *
            qty;

          return {
            id: p.id,
            name: p.name,
            price:
              Number(p.price || 0),
            qty
          };
        });

      checkAndReduceStock(
        safeItems
      );

      const orders =
        read(OF);

      const order = {
        id:
          "VB" +
          Date.now(),

        time:
          new Date().toISOString(),

        status:
          "confirmed",

        payment:
          "Razorpay",

        paymentId:
          razorpay_payment_id,

        razorpayOrderId:
          razorpay_order_id,

        customer,

        items:
          safeItems,

        total:
          calculatedTotal,

        stockRestored:
          false
      };

      orders.unshift(order);

      try {
        write(OF, orders);
      } catch (e) {
        restoreStock(
          safeItems
        );

        throw e;
      }

      res.json({
        ok: true,
        order
      });
    } catch (e) {
      console.error(
        "Payment verify error:",
        e
      );

      res.status(400).json({
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
    console.error(err);

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
  process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(
    "VetBeings running on port " +
    PORT
  );
});

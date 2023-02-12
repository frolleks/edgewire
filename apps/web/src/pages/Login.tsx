import axios from "axios";
import { MouseEvent } from "react";
import { Link } from "react-router-dom";

async function logIn(event: MouseEvent<HTMLButtonElement>) {
  event.preventDefault();
  await axios
    .post("http://localhost:4000/auth/login", {
      email: "email@example.com",
      password: "kjdhsajdjusayewqiegweuwqe",
    })
    .then(
      (response) => {
        console.log(response);
      },
      (error) => {
        console.error(error);
      }
    );
}

function Login() {
  return (
    <>
      <div className="flex h-screen shadow-lg">
        <form className="m-auto flex w-96 flex-col justify-center rounded-md border-2 border-solid border-zinc-700 bg-zinc-800 bg-opacity-95 p-4 backdrop-blur-sm">
          <p className="mx-2 mt-2 text-xl font-bold text-white">
            👋 Welcome to Edgewire!
          </p>
          <p className="mx-2 mb-4 text-white">Sign into Edgewire</p>
          <p className="mx-2 text-white">Email</p>
          <input
            type="email"
            placeholder="Enter your email."
            className="m-2 rounded-md bg-zinc-700 p-2 text-white"
          />
          <p className="mx-2 text-white">Password</p>
          <input
            type="password"
            placeholder="Enter your password."
            className="m-2 rounded-md bg-zinc-700 p-2 text-white"
          />
          <p className="mx-2 text-xs my-1 text-neutral-200">
            New to Edgewire?{" "}
            <Link to="/login/signup" className="text-blue-400">
              Sign up
            </Link>
          </p>
          <button
            type="submit"
            className="m-2 rounded-md bg-zinc-700 p-2 text-white transition hover:bg-blue-500"
          >
            Log in
          </button>
        </form>
      </div>
    </>
  );
}

export default Login;
